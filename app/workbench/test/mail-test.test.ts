// SPDX-License-Identifier: AGPL-3.0-only
import type { Socket } from 'cloudflare:sockets';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bindings, CoreApiDependencies } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { requireAdmin } from '../src/middleware/admin';
import { ProbeTimeoutError, probeSenderSmtp, registerMailTestRoutes } from '../src/routes/mail-test';
import { createSessionToken } from '../src/session';
import { createCoreDb, type CoreTestDb } from './test-factory';

const URL = 'https://team.example.com/api/admin/mail/test';

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

function seedMail(db: CoreTestDb): void {
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'mail', JSON.stringify({ baseUrl: 'https://mail', apiKey: 'key', domain: 'example.com', host: 'smtp', port: 465, username: 'user', password: 'pass', from: 'no-reply@example.com' }));
  db.run("INSERT INTO invites (token_hash, status, personal_email, email_prefix, display_name, expires_at) VALUES ('i', 'pending', 'a@b.test', 'a', 'A', datetime('now', '+1 day'))");
  db.run("INSERT INTO notifications (id, type, payload) VALUES ('n', 'invite_result', '{}')");
  db.run("INSERT INTO builtin_credentials (user_id, username, password_hash) VALUES ('admin', 'admin', 'hash')");
}

function counts(db: CoreTestDb): Record<string, number> {
  return Object.fromEntries(['users', 'invites', 'notifications', 'builtin_credentials', 'audit_log'].map((table) => [table, db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n]));
}

describe('POST /api/admin/mail/test', () => {
  it('双轴成功且零业务写入，仅新增一条 mail_tested 审计', async () => {
    const { env, db, cookie } = await setup();
    seedMail(db);
    const before = counts(db);
    const provisioner = { testConnection: vi.fn(async () => {}) };
    const sender = { testConnection: vi.fn(async () => {}) };
    const res = await app({ createMailProvisioner: () => provisioner as never, createMailSender: () => sender as never }).request(URL, { method: 'POST', headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provisioner: { ok: true, detail: 'Provisioner 连接测试成功' }, sender: { ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' } });
    const after = counts(db);
    for (const table of ['users', 'invites', 'notifications', 'builtin_credentials']) expect(after[table]).toBe(before[table]);
    expect(after.audit_log).toBe(before.audit_log! + 1);
    expect(db.first<{ action: string }>('SELECT action FROM audit_log')).toEqual({ action: 'mail_tested' });
    expect(provisioner.testConnection).toHaveBeenCalledOnce();
    expect(sender.testConnection).toHaveBeenCalledOnce();
  });

  it('provisioner 401 与 sender auth 失败返回指路文案', async () => {
    const { env, db, cookie } = await setup();
    seedMail(db);
    const res = await app({ createMailProvisioner: () => ({ testConnection: async () => { throw new Error('HTTP 401 Unauthorized') } } as never), createMailSender: () => ({ testConnection: async () => { throw new Error('auth failed') } } as never) }).request(URL, { method: 'POST', headers: { cookie } }, env);
    const body = await res.json() as { provisioner: { detail: string }; sender: { detail: string } };
    expect(body.provisioner.detail).toContain('API Key');
    expect(body.sender.detail).toContain('用户名密码');
  });

  it('sender 轴探测超时 → 该轴失败人话（连接超时），请求 200 且双轴结构不变', async () => {
    const { env, db, cookie } = await setup();
    seedMail(db);
    const res = await app({
      createMailProvisioner: () => ({ testConnection: async () => {} }) as never,
      createMailSender: () => ({
        testConnection: async () => {
          throw new ProbeTimeoutError('服务器问候');
        },
      }) as never,
    }).request(URL, { method: 'POST', headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provisioner: { ok: true, detail: 'Provisioner 连接测试成功' },
      sender: { ok: false, detail: '连接超时：服务器问候超过 10s 未响应，请检查 host/port 与防火墙' },
    });
  });

  it('provisioner 轴 JMAP 响应挂起 → 10s 超时折叠为该轴失败人话，请求有限时间内返回', async () => {
    const { env, db, cookie } = await setup();
    seedMail(db);
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
      const pending = app({
        createMailSender: () => ({ testConnection: async () => {} }) as never,
      }).request(URL, { method: 'POST', headers: { cookie } }, env);
      // 等路由走到 JMAP 探测（纯微任务，不依赖计时器）再推进假时钟，避免抢跑
      await fetchStarted;
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        provisioner: {
          ok: false,
          detail: '连接超时：Stalwart 服务超过 10s 未响应，请检查 Stalwart 地址与防火墙',
        },
        sender: { ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' },
      });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('未配置 mail 段时双轴均引导先保存配置', async () => {
    const { env, cookie } = await setup();
    const res = await app().request(URL, { method: 'POST', headers: { cookie } }, env);
    const body = await res.json() as { provisioner: { detail: string }; sender: { detail: string } };
    expect(body.provisioner.detail).toContain('请先保存');
    expect(body.sender.detail).toContain('请先保存');
  });

  it('无 admin cookie 时被真实闸门拒绝为 401', async () => {
    const { env } = await setup();
    expect((await app().request(URL, { method: 'POST' }, env)).status).toBe(401);
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
