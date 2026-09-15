// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 最小 JMAP client：组装 methodCall 数组 → POST → 解析 methodResponses。
 * 单次请求单次调用，不做批量优化/重试/缓存（PRODUCT_SPEC 决策表 + Stalwart 瘦适配）。
 *
 * #189 B1/B5：HTTP 边界失败一律抛结构化 `MailProvisionerError`
 * （401/403 → `AUTH_FAILED`，其余非 2xx → `UPSTREAM_FAILURE` + `httpStatus`，
 * 时限内无响应 → `TIMEOUT`），上层按 code/httpStatus 分类，不再匹配文案。
 */

import { MailProvisionerError } from '@unself/contracts';

/** JMAP methodCall：[方法名, 参数, 调用 id]。 */
export type JmapMethodCall = [name: string, args: Record<string, unknown>, callId: string];

/** JMAP methodResponse：[方法名或 "error", 响应体, 对应调用 id]。 */
export type JmapMethodResponse = [name: string, body: Record<string, unknown>, callId: string];

export interface JmapRequest {
  using: string[];
  methodCalls: JmapMethodCall[];
}

export interface JmapResponse {
  methodResponses: JmapMethodResponse[];
  sessionState?: string;
}

/** Stalwart 管理接口能力（0.16 起 JMAP 对象协议）。 */
export const STALWART_JMAP_CAPABILITIES = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];

/** 单步 JMAP 超时缺省值：10s，与 mail-test 连接探测器同口径（#189 B5）。 */
export const DEFAULT_JMAP_TIMEOUT_MS = 10_000;

export interface PostJmapOptions {
  /** 注入 fetch（单测 mock / 特殊环境）；缺省全局 fetch。 */
  fetchFn?: typeof fetch;
  /** 单次 JMAP 请求超时（ms），缺省 10s。 */
  timeoutMs?: number;
}

/** 超时人话里的秒数：整秒不带小数，非整秒保留一位（配置可改，文案不写死 10s）。 */
function secondsLabel(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? String(timeoutMs / 1000) : (timeoutMs / 1000).toFixed(1);
}

/** 超时错误（#189 B5）：归类 `TIMEOUT`，上层可识别、可折叠成人话。 */
export function jmapTimeoutError(label: string, timeoutMs: number): MailProvisionerError {
  return new MailProvisionerError(
    'TIMEOUT',
    `Stalwart ${label}超时：超过 ${secondsLabel(timeoutMs)}s 未响应`,
  );
}

/** 给一步操作套时限；到点立即抛 `TIMEOUT`（被裹的 promise 由调用方自行善后）。 */
export async function withJmapTimeout<T>(
  operation: () => Promise<T>,
  label: string,
  timeoutMs: number = DEFAULT_JMAP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(jmapTimeoutError(label, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 发送一次 JMAP 请求。网络失败/非 2xx/错误响应一律抛人话 `MailProvisionerError`，
 * 信息含 problemDescription 或 HTTP 状态；到 `timeoutMs` 未响应即中止请求并抛 `TIMEOUT`。
 */
export async function postJmap(
  baseUrl: string,
  apiKey: string | undefined,
  methodCalls: JmapMethodCall[],
  { fetchFn = fetch, timeoutMs = DEFAULT_JMAP_TIMEOUT_MS }: PostJmapOptions = {},
): Promise<JmapResponse> {
  if (!apiKey) {
    throw new MailProvisionerError(
      'AUTH_FAILED',
      'Stalwart API key 未配置：请在实例配置 mail 段填入 apiKey',
    );
  }
  const body: JmapRequest = {
    using: STALWART_JMAP_CAPABILITIES,
    methodCalls,
  };
  const controller = new AbortController();
  let response: Response;
  try {
    response = await withJmapTimeout(async () => {
      const result = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/jmap`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return result;
    }, 'JMAP 请求', timeoutMs);
  } catch (cause) {
    if (cause instanceof MailProvisionerError) {
      // 超时：先让底层请求真正断开（真实 fetch 会因 abort 抛错，由 race 结果先行返回）
      controller.abort();
      throw cause;
    }
    throw new MailProvisionerError(
      'UPSTREAM_FAILURE',
      `Stalwart JMAP 请求失败（网络错误）：${baseUrl}/jmap`,
      { cause },
    );
  }
  if (!response.ok) {
    const authRejected = response.status === 401 || response.status === 403;
    throw new MailProvisionerError(
      authRejected ? 'AUTH_FAILED' : 'UPSTREAM_FAILURE',
      `Stalwart JMAP 请求失败：HTTP ${response.status} ${response.statusText}`,
      { httpStatus: response.status },
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new MailProvisionerError('UPSTREAM_FAILURE', 'Stalwart JMAP 响应不是合法 JSON', { cause });
  }
  const methodResponses = (parsed as { methodResponses?: unknown }).methodResponses;
  if (!Array.isArray(methodResponses)) {
    throw new MailProvisionerError(
      'UPSTREAM_FAILURE',
      'Stalwart JMAP 响应缺少 methodResponses 数组',
    );
  }
  return { methodResponses: methodResponses as JmapMethodResponse[] };
}

/** 从 methodResponses 里取出某个调用 id 的响应；JMAP error 响应或查无此 id 都抛人话错误。 */
export function requireResponse(
  { methodResponses }: JmapResponse,
  callId: string,
): Record<string, unknown> {
  const found = methodResponses.find(([, , id]) => id === callId);
  if (!found) {
    throw new MailProvisionerError(
      'UPSTREAM_FAILURE',
      `Stalwart JMAP 响应缺少调用 ${callId} 的结果`,
    );
  }
  const [name, body] = found;
  if (name === 'error') {
    const description = typeof body['description'] === 'string' ? body['description'] : '';
    throw new MailProvisionerError(
      'UPSTREAM_FAILURE',
      `Stalwart JMAP 调用出错：${description || '未知错误'}`,
    );
  }
  return body;
}

/**
 * Foo/set 响应校验：create 走 created/notCreated，update 走 updated/notUpdated；有错即抛人话错误。
 * SetError 归类（#189 B1）：`alreadyExists` → `ACCOUNT_EXISTS`（上层 409 可恢复冲突）；
 * 密码策略拒绝 → `PASSWORD_REJECTED`（上层 400 用户输入问题）；其余 → `UPSTREAM_FAILURE`。
 */
export function requireSetSuccess(
  body: Record<string, unknown>,
  callId: string,
  createdKey: string,
): Record<string, unknown> {
  const notCreated = body['notCreated'] as Record<string, unknown> | undefined;
  const notUpdated = body['notUpdated'] as Record<string, unknown> | undefined;
  const failure = notCreated?.[createdKey] ?? notUpdated?.[createdKey];
  if (failure && typeof failure === 'object') {
    const { description, type } = failure as { description?: string; type?: string };
    const reason = description ?? type ?? '未知错误';
    if (type === 'alreadyExists') {
      throw new MailProvisionerError(
        'ACCOUNT_EXISTS',
        `Stalwart JMAP ${callId} 写入失败：${reason}`,
      );
    }
    // Stalwart 密码策略拒绝（0.16.20 实测文案：`Password is too weak. Repeats like "abcabcabc"…`）
    // 属用户输入问题；协议文案翻译归适配器，core 只认 code（#189 B1）。
    if (/password is too weak|too weak|password.*policy/i.test(reason)) {
      throw new MailProvisionerError(
        'PASSWORD_REJECTED',
        `Stalwart JMAP ${callId} 写入失败：${reason}`,
      );
    }
    throw new MailProvisionerError(
      'UPSTREAM_FAILURE',
      `Stalwart JMAP ${callId} 写入失败：${reason}`,
    );
  }
  const created = body['created'] as Record<string, unknown> | undefined;
  if (created && typeof created === 'object' && createdKey in created) {
    return created[createdKey] as Record<string, unknown>;
  }
  const updated = body['updated'] as Record<string, unknown> | undefined;
  if (updated && typeof updated === 'object' && createdKey in updated) {
    return updated[createdKey] as Record<string, unknown>;
  }
  throw new MailProvisionerError(
    'UPSTREAM_FAILURE',
    `Stalwart JMAP ${callId} 未返回写入结果`,
  );
}
