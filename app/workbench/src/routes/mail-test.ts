// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 管理端「测试连接」（#117，#340 候选化拆分）：POST /api/admin/mail-stalwart/test 与
 * POST /api/admin/mail-smtp/test 各自独立单轴探测。
 * - 请求体是设置页**当前表单草稿**（候选配置）：只用于本次探测，绝不落 instance_config。
 * - 密钥传空串/'***' → 回退读已存配置段（mail-config.ts 的 read*Section）；两处都没有 →
 *   200 { ok:false, detail:'请先填写完整的 … 配置' }（引导补全，绝不 500）。
 * - provisioner 轴：注入的替身实现 testConnection → 直接调；否则直连 Stalwart JMAP 查域名
 *   （只读，不建号）。sender 轴：注入替身 → 直接调；否则隐式 TLS SMTP
 *   （EHLO→AUTH LOGIN→RSET→QUIT，不投递）。
 * - 结果只回 { ok, detail } 人话；任何异常折叠进失败文案，绝不裸 500；
 *   响应体永不包含密钥明文。
 * - 超时（#150，对齐 #131 口径）：sender 轴 connect/问候/每步应答/写各 10s，
 *   provisioner 轴整步 10s；超时释放 socket 并折叠成该轴人话，绝不挂死。
 * 旧 POST /api/admin/mail/test 已删除（#340 候选化拆分，前端同步改用两新端点）。
 */
import type { connect as CloudflareConnect } from 'cloudflare:sockets';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { Bindings, CoreApiDependencies } from '../index';
import { readSession } from '../session';
import { audit } from '../services/audit';
import { readSmtpSection, readStalwartSection } from '../services/mail-config';

/** 单轴测试结果：ok + 人话 detail（设置页结果卡直显）。 */
type Result = { ok: boolean; detail: string };

/** 可选连接自检能力：测试替身（或未来适配器）实现它即走直调，缺省走真实协议探测。 */
interface TestableProbe {
  testConnection?(): Promise<void>;
}

/** 可注入的连接工厂（生产走 workerd 的 cloudflare:sockets；单测注入假 socket）。 */
export type SenderSocketConnect = typeof CloudflareConnect;

/** 探测阶段超时上限（#150 对齐 #131）：connect / 问候 / 每步应答 / 写各 10s。 */
const PROBE_TIMEOUT_MS = 10_000;

/** 探测超时（人话带阶段）：超时释放 socket 后由 classifyFailure 折叠为该轴失败文案。 */
export class ProbeTimeoutError extends Error {
  constructor(label: string) {
    super(`连接超时：${label}超过 10s 未响应`);
    this.name = 'ProbeTimeoutError';
  }
}

/** 给一步探测套 10s 上限；超时立即抛（socket 由调用方 finally 释放）。 */
async function withTimeout<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError(label)), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 失败文案按轴分类：认证类给指路，其它透传原因。 */
const classifyFailure = (error: unknown, sender: boolean): Result => {
  const message = error instanceof Error ? error.message : String(error);
  // 超时（#150）：该轴失败人话带阶段名与排查建议，绝不让请求挂死
  if (error instanceof ProbeTimeoutError) {
    return {
      ok: false,
      detail: `${message}${sender ? '，请检查 host/port 与防火墙' : '，请检查 Stalwart 地址与防火墙'}`,
    };
  }
  if (!sender && /401|403|unauthor|api.?key/i.test(message)) {
    return { ok: false, detail: '认证失败，请检查 API Key（管理员账号+Inherit）' };
  }
  if (sender && /auth|535|credential|password|username/i.test(message)) {
    return { ok: false, detail: 'SMTP 凭据错误，请检查 SMTP 用户名密码' };
  }
  return {
    ok: false,
    detail: `${sender ? 'SMTP 连接失败，请检查 host/port 与防火墙' : '连接失败，请检查 Stalwart 地址与防火墙'}（${message}）`,
  };
};

/** JMAP methodResponses 成员：[方法名, 参数, 调用 id]；域名探测只认 id 为 'd' 的一条。 */
type JmapDomainReply = [string, { ids?: string[] }, string];

/** provisioner 轴真探测：x:Domain/query 确认域名存在（与开户同协议，只读）。 */
async function probeProvisionerJmap(cfg: Record<string, unknown>): Promise<Result> {
  const baseUrl = str(cfg.baseUrl);
  const apiKey = str(cfg.apiKey);
  const domain = str(cfg.domain);
  if (!baseUrl || !apiKey || !domain) {
    return { ok: false, detail: '请先填写完整的 Stalwart 地址、API Key 与邮箱域名配置' };
  }
  // 整步 10s 上限（#150）：JMAP 挂起同样折叠为该轴失败，不把整个请求吊死。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/jmap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
        methodCalls: [['x:Domain/query', { filter: { name: domain } }, 'd']],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { methodResponses?: unknown[] };
    const reply = body.methodResponses?.find(
      (v): v is JmapDomainReply => Array.isArray(v) && v[2] === 'd',
    );
    if (!reply || reply[0] === 'error' || !reply[1]?.ids?.length) {
      throw Error(`未找到域名 ${domain}`);
    }
    return { ok: true, detail: `已连接，域名 ${domain} 可用` };
  } catch (error) {
    if (controller.signal.aborted) throw new ProbeTimeoutError('Stalwart 服务');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** sender 轴真探测：隐式 TLS SMTP——EHLO → AUTH LOGIN → RSET → QUIT，不投递邮件。 */
export async function probeSenderSmtp(
  cfg: Record<string, unknown>,
  connectFn?: SenderSocketConnect,
): Promise<Result> {
  const host = str(cfg.host);
  const username = str(cfg.username);
  const password = str(cfg.password);
  const from = str(cfg.from);
  const port = Number(cfg.port);
  if (!host || !port || !username || !password || !from) {
    return { ok: false, detail: '请先填写完整的 SMTP host、port、用户名、密码与发件地址配置' };
  }
  const connectImpl = connectFn ?? (await import('cloudflare:sockets')).connect;
  const socket = connectImpl({ hostname: host, port }, { secureTransport: 'on' });
  try {
    await withTimeout(() => socket.opened, '连接');
  } catch (error) {
    // 连不上/超时：无会话可退，先关底层 socket 再交外层分类
    await socket.close().catch(() => {});
    throw error;
  }
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';

  /** 读一行回复；`250-` 续行吞到终行为止（读取按当前阶段计时）。 */
  const readLine = async (label: string): Promise<string> => {
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        return line;
      }
      const chunk = await withTimeout(() => reader.read(), label);
      if (chunk.done) throw Error('连接中断');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  /** 发命令（可选）并断言三位状态码落在 [lo, hi]；写与应答各受 10s 上限。 */
  const command = async (
    lo: number,
    hi: number,
    line: string | undefined,
    label: string,
  ): Promise<void> => {
    if (line) await withTimeout(() => writer.write(encoder.encode(`${line}\r\n`)), '命令写入');
    let reply = await readLine(label);
    while (/^\d{3}-/.test(reply)) reply = await readLine(label);
    const code = Number(reply.slice(0, 3));
    if (code < lo || code > hi) throw Error(`SMTP ${code}`);
  };

  try {
    await command(220, 220, undefined, '服务器问候');
    await command(250, 299, `EHLO ${from.split('@')[1] ?? 'unself'}`, '服务器应答');
    await command(334, 334, 'AUTH LOGIN', '服务器应答');
    await command(334, 334, btoa(username), '服务器应答');
    await command(235, 235, btoa(password), '服务器应答');
    await command(200, 399, 'RSET', '服务器应答');
    await withTimeout(() => writer.write(encoder.encode('QUIT\r\n')), '命令写入');
    return { ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' };
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // 释放失败不掩盖主流程结果
    }
    await socket.close().catch(() => {});
  }
}

/** 已配置密钥占位：空串或 '***' 都表示「表单没给新密钥」。 */
const isUnsetSecret = (value: string): boolean => value.length === 0 || value === '***';

/** 合并表单草稿与已存段（候选化入口取参）：草稿非密钥字段空缺/密钥 *** → 已存值替入。 */
function mergeDraftWithStored(
  draft: Record<string, unknown>,
  stored: Record<string, unknown>,
  secretField: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(draft)) {
    if (field === secretField && typeof value === 'string' && isUnsetSecret(value)) {
      merged[field] = stored[field];
    } else {
      merged[field] = value;
    }
  }
  return merged;
}

/** 候选草稿测试路由规格：审计 target、密钥字段、必填清单与缺失引导文案。 */
interface TestRouteSpec {
  target: 'stalwart' | 'smtp';
  secretField: 'apiKey' | 'password';
  /** 合并后必须齐全的字段（缺任一 → 直接回引导文案，不进探测）。 */
  required: readonly string[];
  missingDetail: string;
}

const STALWART_TEST_SPEC: TestRouteSpec = {
  target: 'stalwart',
  secretField: 'apiKey',
  required: ['baseUrl', 'apiKey', 'domain'],
  missingDetail: '请先填写完整的 Stalwart 地址、API Key 与邮箱域名配置',
};

const SMTP_TEST_SPEC: TestRouteSpec = {
  target: 'smtp',
  secretField: 'password',
  required: ['host', 'port', 'username', 'password', 'from'],
  missingDetail: '请先填写完整的 SMTP host、port、用户名、密码与发件地址配置',
};

/**
 * 合并后草稿是否缺必填（#99/A 评审）：文本字段 trim 后非空；port 接受正整数或纯数字字符串。
 * 必须在调用注入工厂**之前**判——生产组合根里工厂对空配置直接抛结构化错误，
 * 会被 classifyFailure 折成「认证失败，请检查 API Key」这类误导文案（与引导补全语义相悖）。
 */
function missingRequiredFields(cfg: Record<string, unknown>, required: readonly string[]): boolean {
  return required.some((field) => {
    const value = cfg[field];
    if (field === 'port') {
      const port = Number(value);
      return !(Number.isInteger(port) && port > 0);
    }
    return typeof value !== 'string' || value.trim().length === 0;
  });
}

export function registerMailTestRoutes(
  app: Hono<{ Bindings: Bindings }>,
  deps: CoreApiDependencies = {},
): void {
  /**
   * 候选草稿单轴探测的公共主体：表单草稿 + 已存段合并出本次探测配置（不落库），
   * 探测结果只回 { ok, detail }；审计只记动作与 target，不含任何字段值。
   */
  const testDraft = async (
    c: Context<{ Bindings: Bindings }>,
    schema: z.ZodType<Record<string, unknown>>,
    spec: TestRouteSpec,
    probe: (cfg: Record<string, unknown>) => Promise<Result>,
  ): Promise<Response> => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      return c.json({ error: 'invalid settings', detail: z.prettifyError(parsed.error) }, 400);
    }
    // 密钥回退来源按轴分流：stalwart 轴读 mail_stalwart 段，smtp 轴读 mail_smtp 段。
    const stored =
      spec.secretField === 'apiKey'
        ? await readStalwartSection(c.env.CORE_DB)
        : await readSmtpSection(c.env.CORE_DB);
    const cfg = mergeDraftWithStored(parsed.data, stored, spec.secretField);
    // 引导补全（#99）：必填不全在调用注入工厂之前拦下——生产组合根里工厂对空配置直接抛，
    // 那会被 classifyFailure 折成误导文案（「认证失败，请检查 API Key」），管理员被引向错方向。
    if (missingRequiredFields(cfg, spec.required)) {
      return c.json({ ok: false, detail: spec.missingDetail });
    }
    let result: Result;
    try {
      result = await probe(cfg);
    } catch (error) {
      result = classifyFailure(error, spec.target === 'smtp');
    }
    // 密钥铁律（防御性）：失败文案若回显了本次草稿的密钥（上游异常把它拼进 message），一律打码。
    const draftSecret = typeof cfg[spec.secretField] === 'string' ? (cfg[spec.secretField] as string) : '';
    if (!result.ok && draftSecret.length > 0 && draftSecret !== '***') {
      result = { ...result, detail: result.detail.split(draftSecret).join('***') };
    }
    const session = await readSession(c);
    if (session) await audit(c.env.CORE_DB, session.uid, 'mail_tested', spec.target);
    return c.json(result);
  };

  /** 测试邮箱管理（Stalwart 开户）候选草稿：真探测走 JMAP 查域名（只读）。 */
  app.post('/api/admin/mail-stalwart/test', async (c) =>
    testDraft(
      c,
      z
        .object({
          baseUrl: z.string().optional(),
          apiKey: z.string().optional(),
          domain: z.string().optional(),
        })
        .transform((value) => value as unknown as Record<string, unknown>),
      STALWART_TEST_SPEC,
      async (cfg) => {
        const probe = deps.createMailProvisioner?.(cfg) as TestableProbe | undefined;
        if (probe?.testConnection) {
          await probe.testConnection();
          return { ok: true, detail: 'Provisioner 连接测试成功' };
        }
        return probeProvisionerJmap(cfg);
      },
    ),
  );

  /** 测试通知发信（SMTP）候选草稿：真探测走隐式 TLS SMTP（不投递）。 */
  app.post('/api/admin/mail-smtp/test', async (c) =>
    testDraft(
      c,
      z
        .object({
          host: z.string().optional(),
          port: z.union([z.number(), z.string()]).optional(),
          username: z.string().optional(),
          password: z.string().optional(),
          from: z.string().optional(),
        })
        .transform((value) => value as unknown as Record<string, unknown>),
      SMTP_TEST_SPEC,
      async (cfg) => {
        const probe = deps.createMailSender?.(cfg) as TestableProbe | null;
        if (probe?.testConnection) {
          await probe.testConnection();
          return { ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' };
        }
        return probeSenderSmtp(cfg);
      },
    ),
  );
}
