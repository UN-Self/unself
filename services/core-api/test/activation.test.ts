// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 激活域路由级集成（#18 完整实例）：真 SQLite + 假 provisioner/发信口。
 *
 * 覆盖行为：批准后 account_ready 邮件带一次性激活链接（工作邮箱 + 个人邮箱收件）、
 * 站内悬挂行与邮件同链接、GET 只验不消费、POST 设邮箱密码并原子消费令牌、
 * 二次/并发消费只成功一次、弱密码 400 不烧令牌、弱化实例 503 不烧令牌。
 * 断言打在行为（库行/邮件/调用参数）上，改坏业务必红。
 */
import type { MailSender } from '@unself/mail-smtp';
import { createFakeMailProvisioner } from '@unself/stalwart-provisioner';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { hashOneTimeToken } from '../src/one-time-token';
import { createSessionToken } from '../src/session';
import { issueInviteActivation } from '../src/services/invite-activations';
import { createCoreDb, type CoreTestDb } from './test-factory';

/** 完整实例 mail 段（provisioner 与 SMTP 都能装配）。 */
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

/** 申请三字段（与公开填表契约同形）。 */
const APPLICATION = {
  displayName: '新人',
  emailPrefix: 'u_new',
  personalEmail: 'new@personal.example',
};

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

interface ActivationEnv {
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string };
  db: CoreTestDb;
  adminCookie: string;
}

/** 真 users 表 + 管理员会话；withMailConfig 决定完整/弱化实例。 */
async function envFor(withMailConfig = false): Promise<ActivationEnv> {
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
  if (withMailConfig) {
    db.run(
      'INSERT INTO instance_config (key, value) VALUES (?, ?)',
      'mail',
      JSON.stringify(MAIL_CONFIG),
    );
  }
  const adminCookie = `unself_session=${await createSessionToken(
    { uid: 'u_admin', iss: 'https://idp.example.com', sub: 'admin-sub', name: '管理' },
    pair.privateKeyPem,
  )}`;
  return { env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem }, db, adminCookie };
}

function fakeSender(sent: SentMail[]): MailSender {
  return {
    send: async (message) => {
      sent.push({ to: message.to, subject: message.subject, text: message.text });
    },
  };
}

type TestApp = ReturnType<typeof createApp>;

/** 生成 → 填表 → 批准一整链（完整实例），返回邀请哈希。 */
async function approvedInvite(
  app: TestApp,
  env: ActivationEnv['env'],
  adminCookie: string,
): Promise<{ tokenHash: string }> {
  const created = await app.request(
    'https://team.example.com/api/admin/invites',
    {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
    env,
  );
  expect(created.status).toBe(201);
  const { inviteUrl } = (await created.json()) as { inviteUrl: string };
  const inviteToken = inviteUrl.split('/invite/')[1]!;
  const tokenHash = await hashOneTimeToken(inviteToken);

  const submitted = await app.request(
    `https://team.example.com/api/invite/${inviteToken}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(APPLICATION),
    },
    env,
  );
  expect(submitted.status).toBe(200);

  const approved = await app.request(
    `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
    { method: 'POST', headers: { cookie: adminCookie } },
    env,
  );
  expect(approved.status).toBe(200);
  expect((await approved.json()) as { email: string | null }).toMatchObject({
    email: 'u_new@example.com',
  });
  return { tokenHash };
}

/** 从 account_ready 邮件正文提取激活链接（明文只出现在邮件里）。 */
function activationFromMail(sent: SentMail[]): { activateUrl: string; activateToken: string } {
  const mail = sent.find((message) => message.subject.includes('账号已开通'));
  expect(mail, `未找到账号开通邮件，实际：${sent.map((m) => m.subject).join(' / ')}`).toBeDefined();
  const match = /https?:\/\/\S+\/activate\/[A-Za-z0-9_-]+/.exec(mail!.text);
  expect(match, `邮件正文未包含激活链接：${mail!.text}`).not.toBeNull();
  const activateUrl = match![0];
  return { activateUrl, activateToken: activateUrl.split('/activate/')[1]! };
}

/** POST 设密码。 */
async function activate(
  app: TestApp,
  env: ActivationEnv['env'],
  token: string,
  password: string,
): Promise<Response> {
  return app.request(
    `https://team.example.com/api/activate/${token}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    },
    env,
  );
}

describe('激活域 HTTP（#18）', () => {
  it('完整链：批准开号 → account_ready 双通道同链接 → 设密码消费令牌', async () => {
    const provisioner = createFakeMailProvisioner();
    const sent: SentMail[] = [];
    const app = createApp({
      createMailProvisioner: () => provisioner,
      createMailSender: () => fakeSender(sent),
    });
    const { env, db, adminCookie } = await envFor(true);

    const { tokenHash } = await approvedInvite(app, env, adminCookie);
    expect(provisioner.calls.filter((call) => call.method === 'createAccount')).toEqual([
      { method: 'createAccount', input: { emailPrefix: 'u_new', displayName: '新人' } },
    ]);

    // 开通邮件发个人邮箱：正文含工作邮箱与激活链接
    const accountReady = sent.find((message) => message.subject.includes('账号已开通'))!;
    expect(accountReady.to).toBe('new@personal.example');
    expect(accountReady.text).toContain('u_new@example.com');
    const { activateUrl, activateToken } = activationFromMail(sent);
    expect(activateUrl.startsWith('https://team.example.com/activate/')).toBe(true);

    // 站内通知同样悬挂个人邮箱，payload.activateUrl 与邮件链接一致
    const pending = db.first<{
      user_id: string | null;
      invited_email: string | null;
      payload: string;
    }>("SELECT user_id, invited_email, payload FROM notifications WHERE type = 'account_ready'");
    expect(pending).toMatchObject({ user_id: null, invited_email: 'new@personal.example' });
    expect(JSON.parse(pending!.payload)).toEqual({ email: 'u_new@example.com', activateUrl });

    // GET 只验不消费
    const read = await app.request(`https://team.example.com/api/activate/${activateToken}`, {}, env);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ email: 'u_new@example.com' });
    expect(
      db.first<{ used_at: string | null }>(
        'SELECT used_at FROM invite_activations WHERE invite_token_hash = ?',
        tokenHash,
      )?.used_at,
    ).toBeNull();

    // POST 设密码：provisioner 收到工作邮箱 + 明文密码，随后入审计
    const activated = await activate(app, env, activateToken, 'super-secret-1');
    expect(activated.status).toBe(200);
    expect((await activated.json()) as { ok: boolean; loginHint: string }).toMatchObject({
      ok: true,
      loginHint: expect.stringContaining('邮箱账号'),
    });
    expect(provisioner.calls.filter((call) => call.method === 'resetPassword')).toEqual([
      { method: 'resetPassword', input: { email: 'u_new@example.com', password: 'super-secret-1' } },
    ]);
    expect(
      db.first("SELECT actor, action, target FROM audit_log WHERE action = 'account_activated'"),
    ).toEqual({ actor: 'system', action: 'account_activated', target: 'u_new@example.com' });

    // 一次性：库中已标记使用；邀请本身仍是 approved（人等首登 JIT 消费）
    expect(
      db.first<{ used_at: string | null }>(
        'SELECT used_at FROM invite_activations WHERE invite_token_hash = ?',
        tokenHash,
      )?.used_at,
    ).not.toBeNull();
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'approved',
    });
    expect(
      (await app.request(`https://team.example.com/api/activate/${activateToken}`, {}, env)).status,
    ).toBe(404);
  });

  it('同一令牌二次提交 404，密码只被设置一次', async () => {
    const provisioner = createFakeMailProvisioner();
    const sent: SentMail[] = [];
    const app = createApp({
      createMailProvisioner: () => provisioner,
      createMailSender: () => fakeSender(sent),
    });
    const { env, db, adminCookie } = await envFor(true);
    const { tokenHash } = await approvedInvite(app, env, adminCookie);
    const { activateToken } = activationFromMail(sent);

    expect((await activate(app, env, activateToken, 'super-secret-1')).status).toBe(200);
    const second = await activate(app, env, activateToken, 'another-secret-2');
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: '激活链接无效、已使用或已过期' });
    expect(provisioner.calls.filter((call) => call.method === 'resetPassword')).toHaveLength(1);
    expect(
      db.first<{ used_at: string | null }>(
        'SELECT used_at FROM invite_activations WHERE invite_token_hash = ?',
        tokenHash,
      )?.used_at,
    ).not.toBeNull();
  });

  it('并发两次提交同一令牌：恰好一个 200、一个 404，密码只设置一次', async () => {
    const provisioner = createFakeMailProvisioner();
    const sent: SentMail[] = [];
    const app = createApp({
      createMailProvisioner: () => provisioner,
      createMailSender: () => fakeSender(sent),
    });
    const { env, adminCookie } = await envFor(true);
    await approvedInvite(app, env, adminCookie);
    const { activateToken } = activationFromMail(sent);

    const responses = await Promise.all([
      activate(app, env, activateToken, 'super-secret-1'),
      activate(app, env, activateToken, 'super-secret-1'),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
    expect(provisioner.calls.filter((call) => call.method === 'resetPassword')).toHaveLength(1);
  });

  it('弱密码 400 且不消费令牌（GET 仍可读，密码未设置）', async () => {
    const provisioner = createFakeMailProvisioner();
    const sent: SentMail[] = [];
    const app = createApp({
      createMailProvisioner: () => provisioner,
      createMailSender: () => fakeSender(sent),
    });
    const { env, db, adminCookie } = await envFor(true);
    const { tokenHash } = await approvedInvite(app, env, adminCookie);
    const { activateToken } = activationFromMail(sent);

    const short = await activate(app, env, activateToken, '1234567');
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: '密码至少 8 位' });
    expect(
      (
        await app.request(`https://team.example.com/api/activate/${activateToken}`, {}, env)
      ).status,
    ).toBe(200);
    expect(
      db.first<{ used_at: string | null }>(
        'SELECT used_at FROM invite_activations WHERE invite_token_hash = ?',
        tokenHash,
      )?.used_at,
    ).toBeNull();
    expect(provisioner.calls.filter((call) => call.method === 'resetPassword')).toHaveLength(0);
  });

  it('错误令牌 GET/POST 404，不发任何密码重置调用', async () => {
    const provisioner = createFakeMailProvisioner();
    const sent: SentMail[] = [];
    const app = createApp({
      createMailProvisioner: () => provisioner,
      createMailSender: () => fakeSender(sent),
    });
    const { env } = await envFor(true);

    const badGet = await app.request('https://team.example.com/api/activate/wrong-token', {}, env);
    expect(badGet.status).toBe(404);
    expect(await badGet.json()).toEqual({ error: '激活链接无效、已使用或已过期' });
    const badPost = await activate(app, env, 'wrong-token', 'super-secret-1');
    expect(badPost.status).toBe(404);
    expect(provisioner.calls.filter((call) => call.method === 'resetPassword')).toHaveLength(0);
  });

  it('弱化实例：POST 503 不消费令牌，GET 仍可读', async () => {
    const app = createApp({
      createMailProvisioner: () => {
        throw new Error('mail provisioner must stay unconstructed');
      },
    });
    const { env, db } = await envFor();
    const inviteHash = await hashOneTimeToken('invite-token-of-weak-instance');
    const token = await issueInviteActivation(db.d1, inviteHash, 'u_new@example.com');

    const read = await app.request(`https://team.example.com/api/activate/${token}`, {}, env);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ email: 'u_new@example.com' });

    const activated = await activate(app, env, token, 'super-secret-1');
    expect(activated.status).toBe(503);
    expect(await activated.json()).toEqual({
      error: '实例未配置邮件服务，无法设置邮箱密码，请联系管理员',
    });

    // 令牌保留：补配邮件后同一链接仍可用
    expect((await app.request(`https://team.example.com/api/activate/${token}`, {}, env)).status).toBe(
      200,
    );
    expect(
      db.first<{ used_at: string | null }>(
        'SELECT used_at FROM invite_activations WHERE token_hash = ?',
        await hashOneTimeToken(token),
      )?.used_at,
    ).toBeNull();
  });
});
