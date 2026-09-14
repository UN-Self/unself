// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 管理端「测试连接」（#117，评审🔴③-2 收敛）：POST /api/admin/mail/test 双轴探测。
 * - provisioner 轴：注入的替身实现 testConnection → 直接调；否则直连 Stalwart JMAP 查域名（只读，不建号）。
 * - sender 轴：注入的替身实现 testConnection → 直接调；否则裸 TCP SMTP（EHLO→AUTH LOGIN→RSET→QUIT，不投递）。
 * - 结果只回 { ok, detail } 人话；任何异常折叠进对应轴的失败文案，绝不裸 500。
 * #141：整文件从超密单行恢复常规排版；两处鸭子类型 `as any` 以 TestableProbe 收窄，行为零变化。
 */
import { Hono } from 'hono';
import type { Bindings, CoreApiDependencies } from '../index';
import { readSession } from '../session';
import { audit } from '../services/audit';

/** 单轴测试结果：ok + 人话 detail（设置页结果卡直显）。 */
type Result = { ok: boolean; detail: string };

/** 可选连接自检能力：测试替身（或未来适配器）实现它即走直调，缺省走真实协议探测。 */
interface TestableProbe {
  testConnection?(): Promise<void>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** instance_config `mail` 段解析：非对象形状一律回空对象（弱化配置 → 各轴提示补全）。 */
const parseMailConfig = (raw?: string): Record<string, unknown> => {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** 失败文案按轴分类：认证类给指路，其它透传原因。 */
const classifyFailure = (error: unknown, sender: boolean): Result => {
  const message = error instanceof Error ? error.message : String(error);
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
    return { ok: false, detail: '请先保存完整的 Stalwart 地址、API Key 与邮箱域名配置' };
  }
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/jmap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
      methodCalls: [['x:Domain/query', { filter: { name: domain } }, 'd']],
    }),
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
}

/** sender 轴真探测：裸 TCP SMTP——EHLO → AUTH LOGIN → RSET → QUIT，不投递邮件。 */
async function probeSenderSmtp(cfg: Record<string, unknown>): Promise<Result> {
  const host = str(cfg.host);
  const username = str(cfg.username);
  const password = str(cfg.password);
  const from = str(cfg.from);
  const port = Number(cfg.port);
  if (!host || !port || !username || !password || !from) {
    return { ok: false, detail: '请先保存完整的 SMTP host、port、用户名、密码与发件地址配置' };
  }
  const { connect } = await import('cloudflare:sockets');
  const socket = connect({ hostname: host, port, secureTransport: 'on' });
  await socket.opened;
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';

  /** 读一行回复；`250-` 续行吞到终行为止。 */
  const readLine = async (): Promise<string> => {
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        return line;
      }
      const chunk = await reader.read();
      if (chunk.done) throw Error('连接中断');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  /** 发命令（可选）并断言三位状态码落在 [lo, hi]。 */
  const command = async (lo: number, hi: number, line?: string): Promise<void> => {
    if (line) await writer.write(encoder.encode(`${line}\r\n`));
    let reply = await readLine();
    while (/^\d{3}-/.test(reply)) reply = await readLine();
    const code = Number(reply.slice(0, 3));
    if (code < lo || code > hi) throw Error(`SMTP ${code}`);
  };

  try {
    await command(220, 220);
    await command(250, 299, `EHLO ${from.split('@')[1] ?? 'unself'}`);
    await command(334, 334, 'AUTH LOGIN');
    await command(334, 334, btoa(username));
    await command(235, 235, btoa(password));
    await command(200, 399, 'RSET');
    await writer.write(encoder.encode('QUIT\r\n'));
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

export function registerMailTestRoutes(
  app: Hono<{ Bindings: Bindings }>,
  deps: CoreApiDependencies = {},
): void {
  app.post('/api/admin/mail/test', async (c) => {
    const row = await c.env.CORE_DB.prepare("SELECT value FROM instance_config WHERE key = 'mail'")
      .bind()
      .first<{ value: string }>();
    const cfg = parseMailConfig(row?.value);
    let provisioner: Result;
    let sender: Result;
    try {
      const probe = deps.createMailProvisioner?.(cfg) as TestableProbe | undefined;
      if (probe?.testConnection) {
        await probe.testConnection();
        provisioner = { ok: true, detail: 'Provisioner 连接测试成功' };
      } else {
        provisioner = await probeProvisionerJmap(cfg);
      }
    } catch (error) {
      provisioner = classifyFailure(error, false);
    }
    try {
      const probe = deps.createMailSender?.(cfg) as TestableProbe | null;
      if (probe?.testConnection) {
        await probe.testConnection();
        sender = { ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' };
      } else {
        sender = await probeSenderSmtp(cfg);
      }
    } catch (error) {
      sender = classifyFailure(error, true);
    }
    const session = await readSession(c);
    if (session) await audit(c.env.CORE_DB, session.uid, 'mail_tested');
    return c.json({ provisioner, sender });
  });
}
