// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #152 行为测试：重发激活邮件（后台尽力投递 + 投递成功才作废旧链接 + resend 语境文案）。
 *
 * 口径：
 * - 成功重发：旧令牌作废、新链接可用、审计 activation_resent；
 * - 发信失败：旧链接原样可用、未送达的新令牌作废、响应不再 502、审计 activation_resend_failed；
 * - 失败后重试：失败占位行不得遮住旧有效令牌，重试必须 200（#152 验收实锤回归）；
 * - 后台化：注入假 executionCtx（waitUntil）时响应秒回，且投递完成前旧链接仍有效
 *   （作废与投递成功绑定，不是发出请求就毁旧链接）；
 * - 真实双请求链式并发 + 可控 sender 成功/失败交错：按 rowid（签发顺序）收敛，最终仅一个未用链接；
 * - 真实消费激活后重发 409：不因回退搜索旧行而重新放行；
 * - 重复重发：后一次链接替换前一次；已激活→ 409；过期未用令牌仍可重发并获新 48h；
 * - 防账号枚举：不存在与存在但非内置成员同形 404。
 *
 * 断言打在行为上（HTTP 状态 / 库行 / 邮件副作用），改坏业务必红。
 */
import type { MailMessage, MailSender } from '@unself/mail-smtp';
import { createFakeMailProvisioner } from '@unself/contracts';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { hashOneTimeToken } from '../src/one-time-token';
import { createSessionToken } from '../src/session';
import { createCoreDb, type CoreTestDb } from './test-factory';

interface ResendFixture {
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string };
  db: CoreTestDb;
  adminCookie: string;
  /** 重发前已存在的旧明文链接（库里只有哈希）。 */
  oldToken: string;
  oldTokenHash: string;
}

/** 内置 active 成员 + 已批准邀请 + 一条待用旧激活令牌 + mail 段（sender 由测试注入）。 */
async function fixture(): Promise<ResendFixture> {
  const pair = await generateInstanceKeyPair();
  const db = createCoreDb();
  db.run(
    "INSERT INTO users (id, issuer, sub, display_name, personal_email, role, status) VALUES ('u1','builtin','u1','成员','p@example.com','admin','active')",
  );
  db.run(
    "INSERT INTO invites (token_hash,status,personal_email,email_prefix,display_name,expires_at) VALUES ('i1','approved','p@example.com','m','成员','2099-01-01 00:00:00')",
  );
  const oldToken = 'old-plaintext-token';
  const oldTokenHash = await hashOneTimeToken(oldToken);
  db.run(
    "INSERT INTO invite_activations (token_hash, invite_token_hash, email, expires_at) VALUES (?, 'i1', 'm@example.com', datetime('now', '+1 day'))",
    oldTokenHash,
  );
  db.run("INSERT INTO instance_config (key, value) VALUES ('mail', '{}')");
  const admin = await createSessionToken(
    { uid: 'u1', iss: 'x', sub: 'u1', name: '管理员' },
    pair.privateKeyPem,
  );
  return {
    env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem },
    db,
    adminCookie: `unself_session=${admin}`,
    oldToken,
    oldTokenHash,
  };
}

/** 收集发出的邮件正文。 */
function recordingSender(sent: MailMessage[]): MailSender {
  return {
    send: async (message: MailMessage) => {
      sent.push(message);
    },
  };
}

/** 从邮件正文取激活链接里的明文令牌（发给受邀人的唯一携带点）。 */
function activationTokenFrom(text: string): string {
  const token = /\/activate\/(\S+)/.exec(text)?.[1];
  if (!token) {
    throw new Error(`邮件里没有激活链接：${text}`);
  }
  return token;
}

/** POST resend-activation（可注入假 executionCtx）。 */
async function resend(
  app: ReturnType<typeof createApp>,
  fx: ResendFixture,
  memberId = 'u1',
  ctx?: unknown,
): Promise<Response> {
  const init = { method: 'POST', headers: { cookie: fx.adminCookie } } as const;
  const url = `https://team.example.com/api/admin/members/${memberId}/resend-activation`;
  return ctx === undefined
    ? await app.request(url, init, fx.env)
    : await app.request(url, init, fx.env, ctx as never);
}

/** GET 激活页：200 = 链接仍可用，404 = 已作废/过期。 */
function activationPage(app: ReturnType<typeof createApp>, fx: ResendFixture, token: string) {
  return app.request(`https://team.example.com/api/activate/${token}`, {}, fx.env);
}

/** 假 executionCtx：waitUntil 收集 promise，drain 时统一等待（模拟 Workers 生命周期延长）。 */
function fakeExecutionContext(background: Promise<unknown>[]) {
  return {
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
    passThroughOnException: () => {},
    props: {},
  };
}

interface PendingSend {
  message: MailMessage;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** 可控 sender：每个 send 挂起，测试逐个 resolve/reject 编排成功/失败交错。 */
function gatedSender(pending: PendingSend[]): MailSender {
  return {
    send: (message: MailMessage) =>
      new Promise<void>((resolve, reject) => {
        pending.push({ message, resolve, reject });
      }),
  };
}

/** 轮询到条件成立（后台任务推进到发信点），不依赖固定 sleep。 */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!check()) {
    throw new Error('等待条件超时');
  }
}

/** 已投递明文令牌 → 库中 rowid（判定「较新签发者」用，不依赖发信顺序）。 */
async function rowidOf(fx: ResendFixture, token: string): Promise<number> {
  const row = fx.db.first<{ rowid: number }>(
    'SELECT rowid FROM invite_activations WHERE token_hash = ?',
    await hashOneTimeToken(token),
  );
  if (!row) {
    throw new Error('投递令牌不在库中');
  }
  return row.rowid;
}

/** 打两次真实 resend（各自假 executionCtx，链式读到上一未投递令牌），等两封邮件到发信点。 */
async function enterTwoResends(
  app: ReturnType<typeof createApp>,
  fx: ResendFixture,
  pending: PendingSend[],
  background: Promise<unknown>[],
): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    expect((await resend(app, fx, 'u1', fakeExecutionContext(background))).status).toBe(200);
  }
  await until(() => pending.length === 2);
}

/** 取两条已投递记录的 { pending, token, rowid } 并按 rowid 升序（older/newer）。 */
async function orderedSends(fx: ResendFixture, pending: PendingSend[]) {
  const entries = await Promise.all(
    pending.map(async (p) => {
      const token = activationTokenFrom(p.message.text);
      return { pending: p, token, rowid: await rowidOf(fx, token) };
    }),
  );
  entries.sort((a, b) => a.rowid - b.rowid);
  return { older: entries[0]!, newer: entries[1]! };
}

/** 断言处置：已验证的存活明文令牌 200、被取代的 404。 */
async function expectInvalid(
  app: ReturnType<typeof createApp>,
  fx: ResendFixture,
  token: string,
): Promise<void> {
  expect((await activationPage(app, fx, token)).status).toBe(404);
}

describe('#152 重发激活邮件', () => {
  it('成功重发：投递成功后旧令牌作废、新链接可用、审计 activation_resent', async () => {
    const fx = await fixture();
    const sent: MailMessage[] = [];
    const app = createApp({ createMailSender: () => recordingSender(sent) });

    const res = await resend(app, fx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // 旧链接作废：库里置 invalidated@，公开激活页 404
    expect(fx.db.first<{ used_at: string }>('SELECT used_at FROM invite_activations WHERE token_hash = ?', fx.oldTokenHash)?.used_at).toMatch(/^invalidated@/);
    expect((await activationPage(app, fx, fx.oldToken)).status).toBe(404);

    // 新链接可用：只出现在邮件里，库里是未用的新哈希
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('p@example.com');
    const newToken = activationTokenFrom(sent[0]?.text ?? '');
    expect(newToken).not.toBe(fx.oldToken);
    expect(await (await activationPage(app, fx, newToken)).json()).toEqual({ email: 'm@example.com' });
    expect(fx.db.first('SELECT used_at FROM invite_activations WHERE token_hash = ?', await hashOneTimeToken(newToken))).toEqual({ used_at: null });

    expect(fx.db.query("SELECT action, actor FROM audit_log WHERE action = 'activation_resent'")).toEqual([
      { action: 'activation_resent', actor: 'u1' },
    ]);
  });

  it('发信失败：旧链接保留可用、未送达的新令牌作废、响应不再 502', async () => {
    const fx = await fixture();
    const app = createApp({
      createMailSender: () => ({
        send: async () => {
          throw new Error('smtp connection refused');
        },
      }),
    });

    const res = await resend(app, fx);
    // 后台尽力投递：投递结果不再用 502 表达
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // 旧链接原样可用（失败保留旧令牌）
    expect(fx.db.first('SELECT used_at FROM invite_activations WHERE token_hash = ?', fx.oldTokenHash)).toEqual({ used_at: null });
    const oldPage = await activationPage(app, fx, fx.oldToken);
    expect(oldPage.status).toBe(200);
    expect(await oldPage.json()).toEqual({ email: 'm@example.com' });

    // 未送达的新令牌被作废：该邀请只剩旧的一条有效链接
    expect(
      fx.db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM invite_activations WHERE invite_token_hash = 'i1' AND used_at IS NULL",
      ),
    ).toEqual({ count: 1 });
    expect(
      fx.db.first<{ used_at: string }>(
        "SELECT used_at FROM invite_activations WHERE invite_token_hash = 'i1' ORDER BY rowid DESC LIMIT 1",
      )?.used_at,
    ).toMatch(/^invalidated@/);

    // 失败有痕：activation_resend_failed 在场、没有成功审计
    expect(fx.db.query("SELECT action FROM audit_log WHERE action = 'activation_resend_failed'")).toHaveLength(1);
    expect(fx.db.query("SELECT action FROM audit_log WHERE action = 'activation_resent'")).toHaveLength(0);
  });

  it('后台化：假 executionCtx 下响应秒回，投递完成前旧链接仍有效，drain 后旧链接才作废', async () => {
    const fx = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApp({
      createMailSender: () => ({
        send: async () => {
          await gate;
        },
      }),
    });

    const background: Promise<unknown>[] = [];
    const startedAt = Date.now();
    const res = await resend(app, fx, 'u1', fakeExecutionContext(background));
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(res.status).toBe(200);
    expect(background.length).toBeGreaterThan(0);

    // 投递尚未完成：旧链接仍有效（作废绑定投递成功，不是请求一进来就毁）
    expect((await activationPage(app, fx, fx.oldToken)).status).toBe(200);

    // drain 后台：投递成功后才作废旧链接
    release();
    await Promise.allSettled(background);
    expect((await activationPage(app, fx, fx.oldToken)).status).toBe(404);
    expect(fx.db.query("SELECT action FROM audit_log WHERE action = 'activation_resent'")).toHaveLength(1);
  });

  it('重复重发：后一次链接替换前一次，任一时刻仅一个有效链接', async () => {
    const fx = await fixture();
    const sent: MailMessage[] = [];
    const app = createApp({ createMailSender: () => recordingSender(sent) });

    expect((await resend(app, fx)).status).toBe(200);
    const firstToken = activationTokenFrom(sent[0]?.text ?? '');
    expect((await resend(app, fx)).status).toBe(200);
    const secondToken = activationTokenFrom(sent[1]?.text ?? '');

    expect(secondToken).not.toBe(firstToken);
    expect((await activationPage(app, fx, firstToken)).status).toBe(404);
    expect((await activationPage(app, fx, secondToken)).status).toBe(200);
    expect(
      fx.db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM invite_activations WHERE invite_token_hash = 'i1' AND used_at IS NULL",
      ),
    ).toEqual({ count: 1 });
    expect(fx.db.query("SELECT action FROM audit_log WHERE action = 'activation_resent'")).toHaveLength(2);
  });

  it('失败后重试成功：失败占位行不遮住旧有效令牌（不再 409）', async () => {
    const fx = await fixture();
    const sent: MailMessage[] = [];
    let healthy = false;
    const app = createApp({
      createMailSender: () => ({
        send: async (message: MailMessage) => {
          if (!healthy) {
            throw new Error('smtp connection refused');
          }
          sent.push(message);
        },
      }),
    });

    // 第一次：发信失败 → 旧链接保留，失败的新行标记作废
    expect((await resend(app, fx)).status).toBe(200);
    expect(fx.db.first('SELECT used_at FROM invite_activations WHERE token_hash = ?', fx.oldTokenHash)).toEqual({ used_at: null });
    expect((await activationPage(app, fx, fx.oldToken)).status).toBe(200);

    // 第二次：同一 fixture 重试 → 关键回归：必须 200（旧模型因最新行是作废占位而误判 409）
    healthy = true;
    const retry = await resend(app, fx);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true });

    // 重试链接可用、旧链接被取代、只剩一条未用
    expect(sent).toHaveLength(1);
    const retryToken = activationTokenFrom(sent[0]?.text ?? '');
    expect((await activationPage(app, fx, retryToken)).status).toBe(200);
    expect((await activationPage(app, fx, fx.oldToken)).status).toBe(404);
    expect(
      fx.db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM invite_activations WHERE invite_token_hash = 'i1' AND used_at IS NULL",
      ),
    ).toEqual({ count: 1 });
  });

  it('双请求链式并发均成功：只保留较新签发的链接（与完成顺序无关）', async () => {
    const fx = await fixture();
    const pending: PendingSend[] = [];
    const app = createApp({ createMailSender: () => gatedSender(pending) });
    const background: Promise<unknown>[] = [];
    await enterTwoResends(app, fx, pending, background);
    const { older, newer } = await orderedSends(fx, pending);

    // 先放行较早签发者、再放行较新签发者
    older.pending.resolve();
    newer.pending.resolve();
    await Promise.allSettled(background);

    await expectInvalid(app, fx, fx.oldToken);
    await expectInvalid(app, fx, older.token);
    expect((await activationPage(app, fx, newer.token)).status).toBe(200);
    expect(
      fx.db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM invite_activations WHERE invite_token_hash = 'i1' AND used_at IS NULL",
      ),
    ).toEqual({ count: 1 });
  });

  it('双请求并发交错（较新失败 / 较早成功）：失败收敛为较早链接存活', async () => {
    const fx = await fixture();
    const pending: PendingSend[] = [];
    const app = createApp({ createMailSender: () => gatedSender(pending) });
    const background: Promise<unknown>[] = [];
    await enterTwoResends(app, fx, pending, background);
    const { older, newer } = await orderedSends(fx, pending);

    newer.pending.reject(new Error('smtp failed'));
    older.pending.resolve();
    await Promise.allSettled(background);

    await expectInvalid(app, fx, fx.oldToken);
    await expectInvalid(app, fx, newer.token);
    expect((await activationPage(app, fx, older.token)).status).toBe(200);
    expect(
      fx.db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM invite_activations WHERE invite_token_hash = 'i1' AND used_at IS NULL",
      ),
    ).toEqual({ count: 1 });
  });

  it('双请求并发交错（较早失败 / 较新成功）：失败收敛为较新链接存活', async () => {
    const fx = await fixture();
    const pending: PendingSend[] = [];
    const app = createApp({ createMailSender: () => gatedSender(pending) });
    const background: Promise<unknown>[] = [];
    await enterTwoResends(app, fx, pending, background);
    const { older, newer } = await orderedSends(fx, pending);

    older.pending.reject(new Error('smtp failed'));
    newer.pending.resolve();
    await Promise.allSettled(background);

    await expectInvalid(app, fx, fx.oldToken);
    await expectInvalid(app, fx, older.token);
    expect((await activationPage(app, fx, newer.token)).status).toBe(200);
    expect(
      fx.db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM invite_activations WHERE invite_token_hash = 'i1' AND used_at IS NULL",
      ),
    ).toEqual({ count: 1 });
  });

  it('真实消费激活后 resend 409：不因回退搜索旧行而重新放行', async () => {
    const fx = await fixture();
    const sent: MailMessage[] = [];
    const provisioner = createFakeMailProvisioner();
    provisioner.accounts.set('m@example.com', { displayName: '成员', disabled: false, password: 'init' });
    const app = createApp({
      createMailSender: () => recordingSender(sent),
      createMailProvisioner: () => provisioner,
    });

    expect((await resend(app, fx)).status).toBe(200);
    const token = activationTokenFrom(sent[0]?.text ?? '');
    // 走真实激活路由消费（注入假 provisioner，预建工作邮箱账号）
    const activated = await app.request(
      `https://team.example.com/api/activate/${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'newpass123' }),
      },
      fx.env,
    );
    expect(activated.status).toBe(200);

    const before = fx.db.first<{ count: number }>(
      "SELECT COUNT(*) AS count FROM invite_activations WHERE invite_token_hash = 'i1'",
    )?.count;
    const retry = await resend(app, fx);
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { detail: string }).detail).toMatch(/重发|激活链接/);
    expect(
      fx.db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM invite_activations WHERE invite_token_hash = 'i1'",
      )?.count,
    ).toBe(before);
  });

  it('已激活（令牌已消费）→ 409 且零副作用，文案是 resend 语境', async () => {
    const fx = await fixture();
    const sent: MailMessage[] = [];
    const app = createApp({ createMailSender: () => recordingSender(sent) });
    fx.db.run("UPDATE invite_activations SET used_at = datetime('now') WHERE token_hash = ?", fx.oldTokenHash);

    const res = await resend(app, fx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('resend activation failed');
    // 语境守卫：不得复用 approve 的「邮箱开户失败…邀请保持待审批」（resend 没有开户、邀请早已批准）
    expect(body.detail).not.toMatch(/开户|邀请保持待审批|待审批/);
    expect(body.detail).toMatch(/重发|激活链接/);

    expect(sent).toHaveLength(0);
    expect(
      fx.db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM invite_activations WHERE invite_token_hash = 'i1'",
      ),
    ).toEqual({ count: 1 });
    expect(fx.db.query("SELECT action FROM audit_log WHERE action LIKE 'activation_resend%' OR action = 'activation_resent'")).toHaveLength(0);
  });

  it('过期未用的令牌仍可重发，新链接拿到完整 48h 有效期', async () => {
    const fx = await fixture();
    const sent: MailMessage[] = [];
    const app = createApp({ createMailSender: () => recordingSender(sent) });
    fx.db.run("UPDATE invite_activations SET expires_at = datetime('now', '-1 hour') WHERE token_hash = ?", fx.oldTokenHash);
    expect((await activationPage(app, fx, fx.oldToken)).status).toBe(404);

    expect((await resend(app, fx)).status).toBe(200);
    const newToken = activationTokenFrom(sent[0]?.text ?? '');
    expect((await activationPage(app, fx, newToken)).status).toBe(200);
    expect(
      fx.db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM invite_activations WHERE invite_token_hash = 'i1' AND used_at IS NULL AND expires_at > datetime('now', '+47 hours')",
      ),
    ).toEqual({ count: 1 });
  });

  it('防账号枚举：不存在与存在但非内置成员同形 404，不泄露账号是否注册', async () => {
    const fx = await fixture();
    const app = createApp({ createMailSender: () => recordingSender([]) });
    fx.db.run(
      "INSERT INTO users (id, issuer, sub, display_name, email, role, status) VALUES ('u_oidc','https://idp.example.com','oidc-sub','外部','oidc@example.com','user','active')",
    );

    const oidc = await resend(app, fx, 'u_oidc');
    const missing = await resend(app, fx, 'u_missing');
    expect(oidc.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await oidc.json()).toEqual(await missing.json());
  });
});
