// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #152 行为测试：重发激活邮件（后台尽力投递 + 投递成功才作废旧链接 + resend 语境文案）。
 *
 * 口径：
 * - 成功重发：旧令牌作废、新链接可用、审计 activation_resent；
 * - 发信失败：旧链接原样可用、未送达的新令牌作废、响应不再 502、审计 activation_resend_failed；
 * - 后台化：注入假 executionCtx（waitUntil）时响应秒回，且投递完成前旧链接仍有效
 *   （作废与投递成功绑定，不是发出请求就毁旧链接）；
 * - 重复重发：后一次链接替换前一次，任一时刻至多一个有效链接；
 * - 已激活（令牌已消费）→ 409 且零副作用；过期未用令牌仍可重发并获新 48h 有效期；
 * - 防账号枚举：不存在与存在但非内置成员同形 404。
 *
 * 断言打在行为上（HTTP 状态 / 库行 / 邮件副作用），改坏业务必红。
 */
import type { MailMessage, MailSender } from '@unself/mail-smtp';
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

  it('并发抢令牌输家：旧令牌被抢先作废时，本次新链接退位作废', async () => {
    const fx = await fixture();
    const sent: MailMessage[] = [];
    // 双 gate：reached 表示后台已走到发信点（尚未投递成功），gate 控制投递完成时机
    let reachedSend!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedSend = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApp({
      createMailSender: () => ({
        send: async (message: MailMessage) => {
          sent.push(message);
          reachedSend();
          await gate;
        },
      }),
    });

    const background: Promise<unknown>[] = [];
    expect((await resend(app, fx, 'u1', fakeExecutionContext(background))).status).toBe(200);
    await reached;
    const newToken = activationTokenFrom(sent[0]?.text ?? '');

    // 模拟并发 claim/另一次重发在本次投递完成前抢先作废旧令牌（used_at IS NULL 守卫的唯一赢家）
    fx.db.run(
      "UPDATE invite_activations SET used_at = 'invalidated@concurrent' WHERE token_hash = ?",
      fx.oldTokenHash,
    );
    release();
    await Promise.allSettled(background);

    // 输家退位：本次新令牌也被作废，不会留下第二个有效链接
    expect(
      fx.db.first<{ used_at: string }>(
        'SELECT used_at FROM invite_activations WHERE token_hash = ?',
        await hashOneTimeToken(newToken),
      )?.used_at,
    ).toMatch(/^invalidated@/);
    expect((await activationPage(app, fx, newToken)).status).toBe(404);
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
