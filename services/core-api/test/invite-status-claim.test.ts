// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #134 行为测试：邀请状态三态查询 / claim-activation 自助重签 / approve 发信后台化。
 *
 * 覆盖口径（任务书）：
 * - status：pending / approved / activated 三态 + 无效令牌 404 + 失效 410（人话）；
 * - claim：approved+未用 → 200 返回新 activationUrl、旧行 used_at 置位、新 hash 落库；
 *   旧明文链接再激活 → 失败；pending / 已激活 → 409 人话；
 * - approve：假挂起 sender（send 永不 resolve）下审批响应秒回（< 1s，waitUntil 生效证据），
 *   假 ctx drain 后后台副作用（站内通知）在场；无 ctx（vitest 默认）行为测试可同步断言审计。
 *
 * 断言打在行为上（HTTP 状态/库行/邮件副作用），改坏业务必红。
 */
import type { MailSender } from '@unself/mail-smtp';
import { createFakeMailProvisioner, type FakeMailProvisioner } from '@unself/contracts';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { hashOneTimeToken } from '../src/one-time-token';
import { createSessionToken } from '../src/session';
import { consumeInviteActivation } from '../src/services/invite-activations';
import { createCoreDb, type CoreTestDb } from './test-factory';

/** 完整实例 mail 段（provisioner 可装配；sender 由测试注入）。 */
const MAIL_CONFIG = {
  baseUrl: 'https://mail.example.com',
  apiKey: 'k',
  domain: 'example.com',
  host: 'smtp.example.com',
  port: 465,
  username: 'u',
  password: 'p',
  from: 'no-reply@example.com',
};

const APPLICATION = {
  displayName: '新人',
  emailPrefix: 'u_new',
  personalEmail: 'new@personal.example',
};

/** 假发信口记录的邮件（旧明文激活链接从 account_ready 邮件里取）。 */
interface SentMail {
  to: string;
  subject: string;
  text: string;
}

interface Fixture {
  app: TestApp;
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string };
  db: CoreTestDb;
  adminCookie: string;
  provisioner: FakeMailProvisioner;
  sent: SentMail[];
}

/** 每用例一套：真 SQLite + 单实例假 provisioner + 记录型假 sender。 */
async function fixture(): Promise<Fixture> {
  const pair = await generateInstanceKeyPair();
  const db = createCoreDb();
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, email, role) VALUES (?, ?, ?, ?, ?, ?)',
    'u_admin',
    'https://idp.example.com',
    'admin-sub',
    '管理',
    'admin@example.com',
    'admin',
  );
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'mail', JSON.stringify(MAIL_CONFIG));
  const adminCookie = `unself_session=${await createSessionToken(
    { uid: 'u_admin', iss: 'https://idp.example.com', sub: 'admin-sub', name: '管理' },
    pair.privateKeyPem,
  )}`;
  const provisioner = createFakeMailProvisioner();
  const sent: SentMail[] = [];
  const sender: MailSender = {
    send: async (message) => {
      sent.push({ to: message.to, subject: message.subject, text: message.text });
    },
  };
  const app = createApp({
    createMailProvisioner: () => provisioner,
    createMailSender: () => sender,
  });
  return {
    app,
    env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem },
    db,
    adminCookie,
    provisioner,
    sent,
  };
}

type TestApp = ReturnType<typeof createApp>;

async function createInviteVia(fx: Fixture): Promise<{ token: string; tokenHash: string }> {
  const res = await fx.app.request(
    'https://team.example.com/api/admin/invites',
    {
      method: 'POST',
      headers: { cookie: fx.adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
    fx.env,
  );
  expect(res.status).toBe(201);
  const { inviteUrl } = (await res.json()) as { inviteUrl: string };
  const token = inviteUrl.split('/invite/')[1]!;
  return { token, tokenHash: await hashOneTimeToken(token) };
}

async function submitApplication(fx: Fixture, token: string): Promise<Response> {
  return fx.app.request(
    `https://team.example.com/api/invite/${token}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(APPLICATION),
    },
    fx.env,
  );
}

async function approveVia(fx: Fixture, tokenHash: string): Promise<Response> {
  return fx.app.request(
    `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
    { method: 'POST', headers: { cookie: fx.adminCookie } },
    fx.env,
  );
}

/** 走完整链路：建邀请 → 填表 → 批准（完整实例，签发激活令牌）。 */
async function approvedInviteWithActivation(): Promise<{ fx: Fixture; token: string; tokenHash: string }> {
  const fx = await fixture();
  const { token, tokenHash } = await createInviteVia(fx);
  expect((await submitApplication(fx, token)).status).toBe(200);
  expect((await approveVia(fx, tokenHash)).status).toBe(200);
  return { fx, token, tokenHash };
}

describe('#134 邀请状态三态（GET /api/invite/:token/status）', () => {
  it('approved（激活未用）→ activated（激活已用）流转；无效令牌 404', async () => {
    const { fx, token, tokenHash } = await approvedInviteWithActivation();
    const { app, env, db } = fx;

    // 批准后激活令牌未用 → approved
    const approved = await app.request(`https://team.example.com/api/invite/${token}/status`, {}, env);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ status: 'approved' });

    // 激活令牌被消费（激活域服务真路径）→ activated
    const activation = db.first<{ token_hash: string }>('SELECT token_hash FROM invite_activations');
    expect(activation).not.toBeNull();
    const activated = await consumeInviteActivation(db.d1, activation!.token_hash);
    expect(activated).toEqual({ email: 'u_new@example.com' });

    const activatedRes = await app.request(`https://team.example.com/api/invite/${token}/status`, {}, env);
    expect(activatedRes.status).toBe(200);
    expect(await activatedRes.json()).toEqual({ status: 'activated' });

    // 无效令牌：404 人话
    const missing = await app.request('https://team.example.com/api/invite/wrong-token/status', {}, env);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toContain('无效');
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'approved',
    });
  });

  it('注册后未批准：status 回 pending（凭邀请令牌即身份，无需登录）', async () => {
    const fx = await fixture();
    const { token } = await createInviteVia(fx);
    expect((await submitApplication(fx, token)).status).toBe(200);

    const res = await fx.app.request(`https://team.example.com/api/invite/${token}/status`, {}, fx.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pending' });
  });

  it('无激活行的 approved 邀请（弱化实例）→ activated（claim 判定同口径：无待激活即已激活）', async () => {
    const pair = await generateInstanceKeyPair();
    const db = createCoreDb();
    db.run(
      'INSERT INTO users (id, issuer, sub, display_name, email, role) VALUES (?, ?, ?, ?, ?, ?)',
      'u_admin',
      'https://idp.example.com',
      'admin-sub',
      '管理',
      'admin@example.com',
      'admin',
    );
    const adminCookie = `unself_session=${await createSessionToken(
      { uid: 'u_admin', iss: 'https://idp.example.com', sub: 'admin-sub', name: '管理' },
      pair.privateKeyPem,
    )}`;
    const app = createApp();
    const env = { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem };
    const created = await app.request(
      'https://team.example.com/api/admin/invites',
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: '{}',
      },
      env,
    );
    const { inviteUrl } = (await created.json()) as { inviteUrl: string };
    const token = inviteUrl.split('/invite/')[1]!;
    const tokenHash = await hashOneTimeToken(token);
    await app.request(
      `https://team.example.com/api/invite/${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(APPLICATION),
      },
      env,
    );
    await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );

    const res = await app.request(`https://team.example.com/api/invite/${token}/status`, {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'activated' });
  });

  it('过期邀请 → 410 人话（不泄露 expired/rejected 状态机细节）', async () => {
    const fx = await fixture();
    const { token, tokenHash } = await createInviteVia(fx);
    fx.db.run("UPDATE invites SET expires_at = datetime('now', '-1 hour') WHERE token_hash = ?", tokenHash);

    const res = await fx.app.request(`https://team.example.com/api/invite/${token}/status`, {}, fx.env);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('失效');
    expect(body.error).not.toContain('expired');
  });
});

describe('#134 claim-activation（POST /api/invite/:token/claim-activation）', () => {
  it('approved+未用：200 返回新 activationUrl，旧行 used_at 置位，新 hash 落库，旧明文链接激活失败', async () => {
    const { fx, token, tokenHash } = await approvedInviteWithActivation();
    const { app, env, db, sent } = fx;

    // 旧明文链接：只在 account_ready 邮件里出现过一次（批准时签发的原始激活链接）
    const readyMail = sent.find((mail) => mail.subject.includes('账号已开通'));
    expect(readyMail).toBeDefined();
    const originalUrl = readyMail!.text.match(/https:\/\/\S+\/activate\/\S+/)?.[0];
    expect(originalUrl).toBeDefined();
    const originalActivationToken = originalUrl!.split('/activate/')[1]!;

    const rowsBefore = db.query<{ token_hash: string; used_at: string | null }>(
      'SELECT token_hash, used_at FROM invite_activations ORDER BY rowid',
    );
    expect(rowsBefore).toHaveLength(1);
    const originalTokenHash = rowsBefore[0]!.token_hash;
    expect(await hashOneTimeToken(originalActivationToken)).toBe(originalTokenHash);
    expect(rowsBefore[0]!.used_at).toBeNull();

    const claimed = await app.request(
      `https://team.example.com/api/invite/${token}/claim-activation`,
      { method: 'POST' },
      env,
    );
    expect(claimed.status).toBe(200);
    const { activationUrl, email } = (await claimed.json()) as { activationUrl: string; email: string };
    expect(email).toBe('u_new@example.com');
    expect(activationUrl).toMatch(/^https:\/\/team\.example\.com\/activate\/[A-Za-z0-9_-]+$/);

    // 旧行 used_at 置位；新 hash 落库（两行并存，至多一行未用）
    const rowsAfter = db.query<{ token_hash: string; used_at: string | null }>(
      'SELECT token_hash, used_at FROM invite_activations ORDER BY rowid',
    );
    expect(rowsAfter).toHaveLength(2);
    expect(rowsAfter[0]!.token_hash).toBe(originalTokenHash);
    expect(rowsAfter[0]!.used_at).not.toBeNull();
    expect(rowsAfter[1]!.used_at).toBeNull();
    expect(rowsAfter[1]!.token_hash).not.toBe(originalTokenHash);

    // 旧明文链接再激活 → 失败：GET 拿不到工作邮箱，POST 设密码消费不到（一次性）
    const oldApiUrl = originalUrl!.replace('/activate/', '/api/activate/');
    const oldGet = await app.request(oldApiUrl, {}, env);
    expect(oldGet.status).toBe(404);
    const oldPost = await app.request(oldApiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'password123' }),
    }, env);
    expect(oldPost.status).toBe(404);

    // 新链接可用：GET 激活页拿到工作邮箱（只验不消费）
    const newApiUrl = activationUrl.replace('/activate/', '/api/activate/');
    const newLink = await app.request(newApiUrl, {}, env);
    expect(newLink.status).toBe(200);
    expect(await newLink.json()).toEqual({ email: 'u_new@example.com' });

    // 审计在场
    expect(
      db.first("SELECT action, target FROM audit_log WHERE action = 'activation_claimed'"),
    ).toEqual({ action: 'activation_claimed', target: tokenHash });
  });

  it('再次 claim：旧 claim 明文链接失效、新链接可消费（同一时刻至多一个有效链接）', async () => {
    const { fx, token } = await approvedInviteWithActivation();
    const { app, env } = fx;

    const first = await app.request(
      `https://team.example.com/api/invite/${token}/claim-activation`,
      { method: 'POST' },
      env,
    );
    expect(first.status).toBe(200);
    const firstUrl = ((await first.json()) as { activationUrl: string }).activationUrl;

    const second = await app.request(
      `https://team.example.com/api/invite/${token}/claim-activation`,
      { method: 'POST' },
      env,
    );
    expect(second.status).toBe(200);
    const secondUrl = ((await second.json()) as { activationUrl: string }).activationUrl;
    expect(secondUrl).not.toBe(firstUrl);

    // 旧 claim 明文链接：GET 激活页 404（人话），POST 设密码 404 且不落库
    const oldApiUrl = firstUrl.replace('/activate/', '/api/activate/');
    const oldGet = await app.request(oldApiUrl, {}, env);
    expect(oldGet.status).toBe(404);
    const oldPost = await app.request(oldApiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'password123' }),
    }, env);
    expect(oldPost.status).toBe(404);

    // 新链接照常可消费（设邮箱密码走真 provisioner）
    const newApiUrl = secondUrl.replace('/activate/', '/api/activate/');
    const newPost = await app.request(newApiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'password123' }),
    }, env);
    expect(newPost.status).toBe(200);
  });

  it('pending 邀请 claim → 409「管理员审批中」；已激活 → 409「已激活过，请直接登录」', async () => {
    const fx = await fixture();
    const { token, tokenHash } = await createInviteVia(fx);
    expect((await submitApplication(fx, token)).status).toBe(200);

    const pending = await fx.app.request(
      `https://team.example.com/api/invite/${token}/claim-activation`,
      { method: 'POST' },
      fx.env,
    );
    expect(pending.status).toBe(409);
    expect(((await pending.json()) as { error: string }).error).toContain('审批中');
    expect(fx.db.first<{ count: number }>('SELECT COUNT(*) AS count FROM invite_activations')?.count).toBe(0);

    expect((await approveVia(fx, tokenHash)).status).toBe(200);
    // 消费激活令牌（模拟用户已在激活页设完密码）
    const activation = fx.db.first<{ token_hash: string }>('SELECT token_hash FROM invite_activations');
    await consumeInviteActivation(fx.db.d1, activation!.token_hash);

    const done = await fx.app.request(
      `https://team.example.com/api/invite/${token}/claim-activation`,
      { method: 'POST' },
      fx.env,
    );
    expect(done.status).toBe(409);
    expect(((await done.json()) as { error: string }).error).toContain('已激活过');
  });

  it('无效令牌 claim → 404；无激活行的 approved（弱化实例）→ 409 引导直接登录', async () => {
    const pair = await generateInstanceKeyPair();
    const db = createCoreDb();
    db.run(
      'INSERT INTO users (id, issuer, sub, display_name, email, role) VALUES (?, ?, ?, ?, ?, ?)',
      'u_admin',
      'https://idp.example.com',
      'admin-sub',
      '管理',
      'admin@example.com',
      'admin',
    );
    const adminCookie = `unself_session=${await createSessionToken(
      { uid: 'u_admin', iss: 'https://idp.example.com', sub: 'admin-sub', name: '管理' },
      pair.privateKeyPem,
    )}`;
    const app = createApp();
    const env = { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem };

    const missing = await app.request(
      'https://team.example.com/api/invite/wrong-token/claim-activation',
      { method: 'POST' },
      env,
    );
    expect(missing.status).toBe(404);

    const created = await app.request(
      'https://team.example.com/api/admin/invites',
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: '{}',
      },
      env,
    );
    const { inviteUrl } = (await created.json()) as { inviteUrl: string };
    const token = inviteUrl.split('/invite/')[1]!;
    const tokenHash = await hashOneTimeToken(token);
    await app.request(
      `https://team.example.com/api/invite/${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(APPLICATION),
      },
      env,
    );
    await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );

    const noActivation = await app.request(
      `https://team.example.com/api/invite/${token}/claim-activation`,
      { method: 'POST' },
      env,
    );
    expect(noActivation.status).toBe(409);
    expect(((await noActivation.json()) as { error: string }).error).toContain('已激活过');
  });
});

describe('#134 approve 发信后台化', () => {
  it('假挂起 sender + 注入假 executionCtx：审批响应 < 1s 返回且含 status（waitUntil 生效证据）', async () => {
    // 单独装配：挂死 sender 只挂邮件发送，站内写入照常
    const fx = await fixture();
    const hanging: MailSender = {
      send: () =>
        new Promise(() => {
          // 模拟 CF 平台发信挂死：永不 resolve（任务书原话）
        }),
    };
    const app = createApp({
      createMailProvisioner: () => fx.provisioner,
      createMailSender: () => hanging,
    });

    const { token, tokenHash } = await createInviteVia(fx);
    expect((await submitApplication(fx, token)).status).toBe(200);

    // 假 ctx：waitUntil 收集 promise，drain 时统一等待（模拟 Workers 生命周期延长）
    const background: Promise<unknown>[] = [];
    const fakeCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        background.push(promise);
      },
      passThroughOnException: () => {},
      props: {},
    };

    const startedAt = Date.now();
    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: fx.adminCookie } },
      fx.env,
      fakeCtx,
    );
    const elapsed = Date.now() - startedAt;

    // waitUntil 生效证据：挂死发信下响应秒回（若误 await 发信，这里必然超过 1s）
    expect(elapsed).toBeLessThan(1000);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ status: 'approved', email: 'u_new@example.com' });
    expect(background.length).toBeGreaterThan(0);

    // 审批本体不欠账：状态/激活令牌/审计在响应前已落库，不受后台发信影响
    expect(fx.db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'approved',
    });
    expect(fx.db.first<{ count: number }>('SELECT COUNT(*) AS count FROM invite_activations')?.count).toBe(1);
    expect(fx.db.first("SELECT action FROM audit_log WHERE action = 'invite_approved'")).toEqual({
      action: 'invite_approved',
    });
  });

  it('发信失败的 sender + 假 executionCtx：响应秒回；drain 后台后发信失败审计与站内通知在场', async () => {
    const fx = await fixture();
    const failing: MailSender = {
      send: async () => {
        throw new Error('smtp connection refused');
      },
    };
    const app = createApp({
      createMailProvisioner: () => fx.provisioner,
      createMailSender: () => failing,
    });

    const { token, tokenHash } = await createInviteVia(fx);
    expect((await submitApplication(fx, token)).status).toBe(200);

    const background: Promise<unknown>[] = [];
    const fakeCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        background.push(promise);
      },
      passThroughOnException: () => {},
      props: {},
    };

    const startedAt = Date.now();
    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: fx.adminCookie } },
      fx.env,
      fakeCtx,
    );
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(approved.status).toBe(200);

    // drain 假 ctx：后台投递（发信失败→落审计）完成后，副作用全部在场
    await Promise.allSettled(background);
    expect(fx.db.query("SELECT id FROM notifications WHERE type = 'invite_result'")).toHaveLength(1);
    const failureAudit = fx.db.first<{ actor: string; action: string; target: string }>(
      "SELECT actor, action, target FROM audit_log WHERE action = 'notification_email_failed'",
    );
    expect(failureAudit).not.toBeNull();
    expect(failureAudit!.actor).toBe('system');
    expect(failureAudit!.target).toContain('new@personal.example');
    expect(fx.db.first("SELECT action FROM audit_log WHERE action = 'invite_approved'")).toEqual({
      action: 'invite_approved',
    });
  });

  it('无 executionCtx（vitest app.request 默认）：审批响应照常返回，副作用同步在场（防御路径）', async () => {
    const fx = await fixture();
    const { token, tokenHash } = await createInviteVia(fx);
    expect((await submitApplication(fx, token)).status).toBe(200);

    const approved = await approveVia(fx, tokenHash);
    expect(approved.status).toBe(200);

    // 无 ctx → 前台 await：响应返回时站内通知与审计已在库（行为测试可断言）
    expect(fx.db.query("SELECT id FROM notifications WHERE type = 'invite_result'")).toHaveLength(1);
    expect(
      fx.db.first("SELECT action FROM audit_log WHERE action = 'invite_approved'"),
    ).toEqual({ action: 'invite_approved' });
  });
});
