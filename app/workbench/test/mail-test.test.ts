// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 管理端「测试连接」路由测试（#117，#340 候选化拆分）：
 * - POST /api/admin/mail-stalwart/test 与 /api/admin/mail-smtp/test 各自单轴探测；
 * - 请求体是表单草稿（候选配置）：不落 instance_config、新密钥只用于本次探测；
 * - 密钥空串/'***' → 回退已存配置段（服务端视角断言 AUTH 真值，不测内部调用）；
 * - 密钥铁律：响应体 / instance_config / audit_log 三处无密钥明文；
 * - probeSenderSmtp 分级超时（#150）真实协议行为保持原样。
 */
import type { Socket, connect as CloudflareConnect } from 'cloudflare:sockets';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bindings, CoreApiDependencies } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { requireAdmin } from '../src/middleware/admin';
import { ProbeTimeoutError, probeSenderSmtp, registerMailTestRoutes } from '../src/routes/mail-test';
import { createSessionToken } from '../src/session';
import { createCoreDb, type CoreTestDb } from './test-factory';
import { createStalwartMailProvisioner, toStalwartProvisionerConfig } from '@unself/stalwart-provisioner';

const smtpSocket = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('cloudflare:sockets', () => smtpSocket);

const STALWART_URL = 'https://team.example.com/api/admin/mail-stalwart/test';
const SMTP_URL = 'https://team.example.com/api/admin/mail-smtp/test';

/** 外部 SMTP 边界：只在 options 开启 TLS 时发问候，并按客户端命令返回应答。 */
function implicitTlsProbeServer(authReply = '235 ok') {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let tls = false;
  let closed = false;
  const commands: string[] = [];
  const replies = ['220 ready', '250 ok', '334 Username', '334 Password', authReply, '250 reset', '221 bye'];
  const encoder = new TextEncoder();
  const respond = () => {
    const reply = replies.shift();
    if (reply) controller.enqueue(encoder.encode(`${reply}\r\n`));
  };
  const socket: Socket = {
    readable: new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
    writable: new WritableStream<Uint8Array>({ write(chunk) {
      commands.push(new TextDecoder().decode(chunk));
      if (tls) respond();
    } }),
    opened: Promise.resolve(), closed: Promise.resolve(),
    async close() { closed = true; controller.close(); },
    startTls() { throw new Error('Implicit TLS server'); },
  };
  return {
    connect: ((_address, options?: import('cloudflare:sockets').SocketOptions) => {
      tls = options?.secureTransport === 'on';
      if (tls) respond();
      return socket;
    }) satisfies typeof CloudflareConnect,
    commands: () => commands.join(''),
    closed: () => closed,
  };
}

async function setup(): Promise<{ env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string }; db: CoreTestDb; cookie: string }> {
  const pair = await generateInstanceKeyPair();
  const db = createCoreDb();
  db.run("INSERT INTO users (id, issuer, sub, display_name, role) VALUES ('admin', 'i', 's', '管理员', 'admin')");
  const token = await createSessionToken({ uid: 'admin', iss: 'i', sub: 's', name: '管理员' }, pair.privateKeyPem);
  return { env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem }, db, cookie: `unself_session=${token}` };
}

function app(deps?: CoreApiDependencies): Hono<{ Bindings: Bindings }> {
  const instance = new Hono<{ Bindings: Bindings }>();
  instance.use('/api/admin/*', requireAdmin());
  registerMailTestRoutes(instance, deps);
  return instance;
}

/** 已存的完整配置段（#340 分域键）。 */
const STALWART_STORED = { enabled: true, baseUrl: 'https://mail', apiKey: 'key', domain: 'example.com' };
const SMTP_STORED = { enabled: true, host: 'smtp', port: 465, username: 'user', password: 'pass', from: 'no-reply@example.com' };

function seedStalwart(db: CoreTestDb, section: Record<string, unknown> = STALWART_STORED): void {
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'mail_stalwart', JSON.stringify(section));
}

function seedSmtp(db: CoreTestDb, section: Record<string, unknown> = SMTP_STORED): void {
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'mail_smtp', JSON.stringify(section));
}

/** 业务表种子行：证明探测端点对业务数据零写入（invite/通知/凭据全不动）。 */
function seedBusinessRows(db: CoreTestDb): void {
  db.run("INSERT INTO invites (token_hash, status, personal_email, email_prefix, display_name, expires_at) VALUES ('i', 'pending', 'a@b.test', 'a', 'A', datetime('now', '+1 day'))");
  db.run("INSERT INTO notifications (id, type, payload) VALUES ('n', 'invite_result', '{}')");
  db.run("INSERT INTO builtin_credentials (user_id, username, password_hash) VALUES ('admin', 'admin', 'hash')");
}

/** 业务表 + instance_config 行数快照（探测前后必须全等：候选测试零落库）。 */
function snapshot(db: CoreTestDb): Record<string, number> {
  const tables = ['users', 'invites', 'notifications', 'builtin_credentials', 'instance_config'];
  return Object.fromEntries(tables.map((table) => [table, db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n]));
}

/** 审计 mail_tested 按 target 计数。 */
function auditCount(db: CoreTestDb, target: string): number {
  return db.first<{ count: number }>(
    "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'mail_tested' AND target = ?",
    target,
  )!.count;
}

describe('POST /api/admin/mail-smtp/test（#340 候选化）', () => {
  it.each([false, true])('TLS 边界：真实 SMTP 探测返回接口结果，缺失 TLS=%s', async (dropTls) => {
    const { env, cookie } = await setup();
    const server = implicitTlsProbeServer();
    let started!: () => void;
    const connected = new Promise<void>((resolve) => { started = resolve; });
    smtpSocket.connect.mockImplementation((address, options) => {
      const socket = server.connect(address, dropTls ? undefined : options);
      started();
      return socket;
    });
    vi.useFakeTimers();
    try {
      // 不注入任何替身：SMTP 轴走真实探测路径（cloudflare:sockets mock → 假服务器）。
      const pending = app().request(SMTP_URL, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'smtp', port: 465, username: 'user', password: 'pass', from: 'no-reply@example.com' }),
      }, env);
      await connected;
      await vi.advanceTimersByTimeAsync(10_000);
      const response = await pending;
      expect(response.status).toBe(200);
      const result = await response.json() as { ok: boolean; detail: string };
      expect(result.ok).toBe(!dropTls);
      if (dropTls) {
        expect(result.detail).toContain('服务器问候超过 10s');
        expect(server.commands()).toBe('');
      } else {
        expect(server.commands()).toContain('RSET\r\nQUIT\r\n');
      }
      expect(server.commands()).not.toMatch(/MAIL FROM|RCPT TO|DATA/);
      expect(server.closed()).toBe(true);
    } finally {
      vi.useRealTimers();
      smtpSocket.connect.mockReset();
    }
  });

  it('注入替身 testConnection 成功 → 200 { ok:true }，审计 target=smtp', async () => {
    const { env, db, cookie } = await setup();
    const res = await app({ createMailSender: () => ({ testConnection: async () => {} }) as never }).request(
      SMTP_URL,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'smtp', port: 465, username: 'user', password: 'pass', from: 'no-reply@example.com' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' });
    expect(auditCount(db, 'smtp')).toBe(1);
    expect(auditCount(db, 'stalwart')).toBe(0);
  });

  it('候选草稿不落库：业务表与 instance_config 行数零变化（原本无 mail_smtp 行则依旧无行）', async () => {
    const { env, db, cookie } = await setup();
    seedBusinessRows(db);
    const before = snapshot(db);

    const res = await app({ createMailSender: () => ({ testConnection: async () => {} }) as never }).request(
      SMTP_URL,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'smtp.example.com', port: 587, username: 'u', password: 'p', from: 'n@x.com' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' });
    expect(snapshot(db)).toEqual(before);
    expect(db.first('SELECT value FROM instance_config WHERE key = ?', 'mail_smtp')).toBeNull();
  });

  it('已存段的草稿探测不落库：改 host 的草稿不动库里 mail_smtp 行', async () => {
    const { env, db, cookie } = await setup();
    seedSmtp(db);
    const before = db.query('SELECT key, value FROM instance_config ORDER BY key');

    const res = await app({ createMailSender: () => ({ testConnection: async () => {} }) as never }).request(
      SMTP_URL,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'smtp2.example.com', port: 587, username: 'u', password: '***', from: 'n@x.com' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' });
    expect(db.query('SELECT key, value FROM instance_config ORDER BY key')).toEqual(before);
  });

  it('密钥空串：无已存段 → 引导补全（不 500）；有已存段 → AUTH 用库中真值（服务端视角）', async () => {
    // 干净库：password 空串且无 mail_smtp 行 → 回退后仍缺 → 请先填写。
    const clean = await setup();
    const miss = await app().request(SMTP_URL, {
      method: 'POST',
      headers: { cookie: clean.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'smtp', port: 465, username: 'user', password: '', from: 'no-reply@example.com' }),
    }, clean.env);
    expect(miss.status).toBe(200);
    expect(((await miss.json()) as { ok: boolean; detail: string }).detail).toContain('请先填写完整的 SMTP');

    // 有 mail_smtp 行：password 空串 → 库中真值替入，AUTH LOGIN 提交的就是库中 user/pass。
    const { env, db, cookie } = await setup();
    seedSmtp(db);
    const server = implicitTlsProbeServer();
    smtpSocket.connect.mockImplementation(server.connect);
    try {
      const res = await app().request(SMTP_URL, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'smtp', port: 465, username: 'user', password: '', from: 'no-reply@example.com' }),
      }, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' });
      expect(server.commands()).toContain(`${btoa('user')}\r\n`);
      expect(server.commands()).toContain(`${btoa('pass')}\r\n`);
    } finally {
      smtpSocket.connect.mockReset();
    }
  });

  it('密钥 *** 同样回退已存段；新密钥只用于本次探测、库中真值不动', async () => {
    const { env, db, cookie } = await setup();
    seedSmtp(db);
    const before = db.query('SELECT key, value FROM instance_config ORDER BY key');
    const server = implicitTlsProbeServer();
    smtpSocket.connect.mockImplementation(server.connect);
    try {
      // *** → 库中真值 pass；随后同一表单换新密钥 → 提交的是新值。
      const masked = await app().request(SMTP_URL, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'smtp', port: 465, username: 'user', password: '***', from: 'no-reply@example.com' }),
      }, env);
      expect(await masked.json()).toEqual({ ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' });
      expect(server.commands()).toContain(`${btoa('pass')}\r\n`);

      const fresh = implicitTlsProbeServer();
      smtpSocket.connect.mockImplementation(fresh.connect);
      const changed = await app().request(SMTP_URL, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'smtp', port: 465, username: 'user', password: 'new-secret', from: 'no-reply@example.com' }),
      }, env);
      expect(await changed.json()).toEqual({ ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' });
      expect(fresh.commands()).toContain(`${btoa('new-secret')}\r\n`);
      expect(fresh.commands()).not.toContain(btoa('pass'));
    } finally {
      smtpSocket.connect.mockReset();
    }
    // 探测全程零落库：库中 password 真值仍是旧值。
    expect(db.query('SELECT key, value FROM instance_config ORDER BY key')).toEqual(before);
    expect(JSON.parse(db.first<{ value: string }>('SELECT value FROM instance_config WHERE key = ?', 'mail_smtp')!.value)).toMatchObject({ password: 'pass' });
  });

  it('失败分类：auth 失败 → 凭据指路；超时 → 超时人话；均 200 不裸 500', async () => {
    const { env, cookie } = await setup();
    const draft = { host: 'smtp', port: 465, username: 'user', password: 'pass', from: 'no-reply@example.com' };
    const authFail = await app({ createMailSender: () => ({ testConnection: async () => { throw new Error('auth failed'); } }) as never }).request(
      SMTP_URL,
      { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(draft) },
      env,
    );
    expect(authFail.status).toBe(200);
    expect(((await authFail.json()) as { detail: string }).detail).toContain('SMTP 凭据错误');

    const timeout = await app({ createMailSender: () => ({ testConnection: async () => { throw new ProbeTimeoutError('服务器问候'); } }) as never }).request(
      SMTP_URL,
      { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(draft) },
      env,
    );
    expect(timeout.status).toBe(200);
    expect(((await timeout.json()) as { detail: string }).detail).toBe('连接超时：服务器问候超过 10s 未响应，请检查 host/port 与防火墙');
  });

  it('密钥铁律：响应体 / instance_config / audit_log 三处 grep 无密钥明文', async () => {
    const { env, db, cookie } = await setup();
    const res = await app({ createMailSender: () => ({ testConnection: async () => {} }) as never }).request(
      SMTP_URL,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'smtp.example.com', port: 587, username: 'u', password: 'draft-secret', from: 'n@x.com' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const responseText = await res.text();
    expect(responseText).not.toContain('draft-secret');
    expect(JSON.stringify(db.query('SELECT key, value FROM instance_config'))).not.toContain('draft-secret');
    expect(db.first('SELECT value FROM instance_config WHERE key = ?', 'mail_smtp')).toBeNull();
    const audits = db.query('SELECT actor, action, target FROM audit_log');
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain('draft-secret');
    expect(audits[0]).toEqual({ actor: 'admin', action: 'mail_tested', target: 'smtp' });
  });

  it('无 admin cookie 时被真实闸门拒绝为 401', async () => {
    const { env } = await setup();
    const res = await app().request(SMTP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'smtp', port: 465, username: 'u', password: 'p', from: 'n@x.com' }),
    }, env);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/mail-stalwart/test（#340 候选化）', () => {
  it('注入替身 testConnection 成功 → 200 Provisioner 成功文案，审计 target=stalwart', async () => {
    const { env, db, cookie } = await setup();
    const res = await app({ createMailProvisioner: () => ({ testConnection: async () => {} }) as never }).request(
      STALWART_URL,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'https://mail', apiKey: 'key', domain: 'example.com' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, detail: 'Provisioner 连接测试成功' });
    expect(auditCount(db, 'stalwart')).toBe(1);
    expect(auditCount(db, 'smtp')).toBe(0);
  });

  it('候选草稿不落库：干净库测完依旧无 mail_stalwart 行，业务表零写入', async () => {
    const { env, db, cookie } = await setup();
    seedBusinessRows(db);
    const before = snapshot(db);

    const res = await app({ createMailProvisioner: () => ({ testConnection: async () => {} }) as never }).request(
      STALWART_URL,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'https://draft.example.com', apiKey: 'draft-key', domain: 'draft.com' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, detail: 'Provisioner 连接测试成功' });
    expect(snapshot(db)).toEqual(before);
    expect(db.first('SELECT value FROM instance_config WHERE key = ?', 'mail_stalwart')).toBeNull();
  });

  it('密钥 ***：无已存行 → 引导补全；有已存行 → 库中真值替入（JMAP 探测成功）', async () => {
    // 干净库：apiKey *** 且无行 → 回退后缺 → 请先填写。
    const clean = await setup();
    const miss = await app().request(STALWART_URL, {
      method: 'POST',
      headers: { cookie: clean.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://mail', apiKey: '***', domain: 'example.com' }),
    }, clean.env);
    expect(miss.status).toBe(200);
    expect(((await miss.json()) as { detail: string }).detail).toContain('请先填写完整的 Stalwart');

    // 有 mail_stalwart 行：*** → 库中 apiKey 替入，探测成功（fetch 替身回 JMAP 域名应答）。
    const { env, db, cookie } = await setup();
    seedStalwart(db);
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ methodResponses: [['x:Domain/query', { ids: ['d1'] }, 'd']] }),
    }));
    try {
      const res = await app().request(STALWART_URL, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'https://mail', apiKey: '***', domain: 'example.com' }),
      }, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, detail: '已连接，域名 example.com 可用' });
    } finally {
      vi.unstubAllGlobals();
    }
    // 候选测试零落库：库中 apiKey 真值原样。
    expect(JSON.parse(db.first<{ value: string }>('SELECT value FROM instance_config WHERE key = ?', 'mail_stalwart')!.value)).toMatchObject({ apiKey: 'key' });
  });

  it('#99 生产组合根（注入真适配器）：空草稿缺字段 → 引导补全文案，不被适配器异常折成「认证失败」', async () => {
    // 复刻 entry.prod.ts 的注入方式：工厂对空配置直接抛 → 异常分支会顶掉引导文案。
    const { env, cookie } = await setup();
    const res = await app({
      createMailProvisioner: (cfg) => createStalwartMailProvisioner(toStalwartProvisionerConfig(cfg)),
    }).request(
      STALWART_URL,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: '', apiKey: '', domain: '' }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toBe('请先填写完整的 Stalwart 地址、API Key 与邮箱域名配置');
    expect(body.detail).not.toContain('认证失败');
    expect(body.detail).not.toContain('unself.config');
  });

  it('密钥铁律（失败路径）：上游错误把草稿密钥拼进 message → 响应仍打码，不回显明文', async () => {
    const { env, cookie } = await setup();
    const res = await app({
      createMailProvisioner: () => ({
        testConnection: async () => {
          throw new Error('boom with draft-secret-key inside');
        },
      }) as never,
    }).request(
      STALWART_URL,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'https://mail', apiKey: 'draft-secret-key', domain: 'example.com' }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.detail).not.toContain('draft-secret-key');
    expect(body.detail).toContain('***');
  });

  it('认证失败（HTTP 401）→ API Key 指路文案，200 不裸 500', async () => {
    const { env, cookie } = await setup();
    const res = await app({ createMailProvisioner: () => ({ testConnection: async () => { throw new Error('HTTP 401 Unauthorized'); } }) as never }).request(
      STALWART_URL,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'https://mail', apiKey: 'key', domain: 'example.com' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { detail: string }).detail).toContain('API Key');
  });

  it('JMAP 响应挂起 → 10s 超时折叠为失败人话，请求有限时间内返回', async () => {
    const { env, cookie } = await setup();
    vi.useFakeTimers();
    try {
      let markFetchStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => {
        markFetchStarted = resolve;
      });
      vi.stubGlobal('fetch', (_url: unknown, init?: { signal?: AbortSignal }) => {
        markFetchStarted();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        });
      });
      const pending = app({ createMailSender: () => ({ testConnection: async () => {} }) as never }).request(STALWART_URL, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'https://mail', apiKey: 'key', domain: 'example.com' }),
      }, env);
      // 等路由走到 JMAP 探测（纯微任务，不依赖计时器）再推进假时钟，避免抢跑
      await fetchStarted;
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: false,
        detail: '连接超时：Stalwart 服务超过 10s 未响应，请检查 Stalwart 地址与防火墙',
      });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('无 admin cookie 时被真实闸门拒绝为 401', async () => {
    const { env } = await setup();
    const res = await app().request(STALWART_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://mail', apiKey: 'key', domain: 'example.com' }),
    }, env);
    expect(res.status).toBe(401);
  });
});

/** 假 socket：opened/写可挂起、可脚本化下发应答；记录 close 次数（对照 #131 的 mock 口径）。 */
function fakeSocket(options: { opened?: Promise<unknown>; replies?: string[]; hangWrite?: boolean }) {
  let closeCount = 0;
  const encoder = new TextEncoder();
  const socket: Socket = {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const reply of options.replies ?? []) controller.enqueue(encoder.encode(`${reply}\r\n`));
        // 不 close：模拟服务器不再说话，让读取落到超时
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write: () => (options.hangWrite ? new Promise<void>(() => {}) : Promise.resolve()),
    }),
    opened: options.opened ?? Promise.resolve(),
    closed: Promise.resolve(),
    close: async () => {
      closeCount += 1;
    },
    startTls: () => {
      throw new Error('探测器不走 STARTTLS');
    },
  };
  return { socket, closeCount: () => closeCount };
}

const PROBE_CFG = {
  host: 'smtp.example.com',
  port: 465,
  username: 'user',
  password: 'pass',
  from: 'no-reply@example.com',
};

const TIMEOUT_CASES: Array<[string, Parameters<typeof fakeSocket>[0], string]> = [
  ['连接挂起', { opened: new Promise<void>(() => {}) }, '连接超时：连接超过 10s 未响应'],
  ['连上后无 220 问候', { replies: [] }, '连接超时：服务器问候超过 10s 未响应'],
  ['220 后 EHLO 无应答', { replies: ['220 ready'] }, '连接超时：服务器应答超过 10s 未响应'],
];

describe('probeSenderSmtp 分级超时（#150，对齐 #131）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('TLS 边界：完成隐式 TLS 认证与退出，不投递邮件', async () => {
    const server = implicitTlsProbeServer();
    const outcome = probeSenderSmtp(PROBE_CFG, server.connect).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toMatchObject({ ok: true });
    expect(server.commands()).toContain('AUTH LOGIN\r\n');
    expect(server.commands()).toContain('RSET\r\nQUIT\r\n');
    expect(server.commands()).not.toMatch(/MAIL FROM|RCPT TO|DATA/);
    expect(server.closed()).toBe(true);
  });

  it('TLS 边界：未启用 TLS 时问候超时，不发送凭据，关闭连接', async () => {
    const server = implicitTlsProbeServer();
    const pending = probeSenderSmtp(PROBE_CFG, (address) => server.connect(address));
    const rejection = expect(pending).rejects.toMatchObject({ name: 'ProbeTimeoutError', message: '连接超时：服务器问候超过 10s 未响应' });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(server.commands()).toBe('');
    expect(server.closed()).toBe(true);
  });

  it('TLS 边界：认证拒绝时不提交邮件并关闭连接', async () => {
    const server = implicitTlsProbeServer('535 Authentication failed');
    const outcome = probeSenderSmtp(PROBE_CFG, server.connect).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toBe('SMTP 535');
    expect(server.commands()).not.toMatch(/MAIL FROM|RCPT TO|DATA/);
    expect(server.closed()).toBe(true);
  });

  it.each(TIMEOUT_CASES)('%s → 10s 超时并关闭 socket', async (_label, socketOptions, message) => {
    const { socket, closeCount } = fakeSocket(socketOptions);
    const pending = probeSenderSmtp(PROBE_CFG, () => socket);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'ProbeTimeoutError', message });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(closeCount()).toBe(1);
  });

  it('命令写入挂起 → 10s 写入超时并关闭 socket', async () => {
    const { socket, closeCount } = fakeSocket({ replies: ['220 ready'], hangWrite: true });
    const pending = probeSenderSmtp(PROBE_CFG, () => socket);
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'ProbeTimeoutError',
      message: '连接超时：命令写入超过 10s 未响应',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(closeCount()).toBe(1);
  });

  it('happy path：10s 内完成 EHLO→AUTH→RSET→QUIT 并返回成功人话', async () => {
    const { socket } = fakeSocket({
      replies: ['220 ready', '250 ok', '334 VXNlcm5hbWU6', '334 UGFzc3dvcmQ6', '235 ok', '250 ok'],
    });
    await expect(probeSenderSmtp(PROBE_CFG, () => socket)).resolves.toEqual({
      ok: true,
      detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）',
    });
  });
});
