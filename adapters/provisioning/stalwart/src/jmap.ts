// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 最小 JMAP client：组装 methodCall 数组 → POST → 解析 methodResponses。
 * 单次请求单次调用，不做批量优化/重试/缓存（PRODUCT_SPEC §6.6 Stalwart 瘦适配）。
 */

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

/**
 * 发送一次 JMAP 请求。网络失败/非 2xx/错误响应一律抛 Error，
 * 信息含 problemDescription 或 HTTP 状态，人话可读。
 */
export async function postJmap(
  baseUrl: string,
  apiKey: string | undefined,
  methodCalls: JmapMethodCall[],
  fetchFn: typeof fetch = fetch,
): Promise<JmapResponse> {
  if (!apiKey) {
    throw new Error('Stalwart API key 未配置：请在实例配置 mail 段填入 apiKey');
  }
  const body: JmapRequest = {
    using: STALWART_JMAP_CAPABILITIES,
    methodCalls,
  };
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/jmap`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error(`Stalwart JMAP 请求失败（网络错误）：${baseUrl}/jmap`, { cause });
  }
  if (!response.ok) {
    throw new Error(`Stalwart JMAP 请求失败：HTTP ${response.status} ${response.statusText}`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new Error('Stalwart JMAP 响应不是合法 JSON', { cause });
  }
  const methodResponses = (parsed as { methodResponses?: unknown }).methodResponses;
  if (!Array.isArray(methodResponses)) {
    throw new Error('Stalwart JMAP 响应缺少 methodResponses 数组');
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
    throw new Error(`Stalwart JMAP 响应缺少调用 ${callId} 的结果`);
  }
  const [name, body] = found;
  if (name === 'error') {
    const description = typeof body['description'] === 'string' ? body['description'] : '';
    throw new Error(`Stalwart JMAP 调用出错：${description || '未知错误'}`);
  }
  return body;
}

/** Foo/set 响应校验：create 走 created/notCreated，update 走 updated/notUpdated；有错即抛人话错误。 */
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
    throw new Error(
      `Stalwart JMAP ${callId} 写入失败：${description ?? type ?? '未知错误'}`,
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
  throw new Error(`Stalwart JMAP ${callId} 未返回写入结果`);
}
