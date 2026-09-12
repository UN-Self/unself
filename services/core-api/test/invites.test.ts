// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 邀请域路由级集成（#18）：真 SQLite（迁移建表）+ http 级断言。
 *
 * 覆盖行为：生成（明文只回一次/哈希落库/限期/审计）、公开填表与管理员广播、
 * 弱化实例只置 approved（首登按个人邮箱消费）、前缀占用可恢复 409、过期惰性 410、
 * 鉴权边界与审批状态守卫。故意改坏任何一端业务（丢哈希、漏广播、误置状态）都会红。
 */
import type { MailSender } from '@unself/mail-smtp';
import { MailProvisionerError, createFakeMailProvisioner } from '@unself/stalwart-provisioner';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { hashOneTimeToken } from '../src/one-time-token';
import { createSessionToken } from '../src/session';
import { consumeApprovedInviteByEmail } from '../src/services/invites';
import { createCoreDb, type CoreTestDb } from './test-factory';

/** 与 routes/settings.ts 契约一致的完整 mail 段（provisioner 与 SMTP 都能装配）。 */
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

/** 假发信口记录的邮件（断言收件人/主题/正文）。 */
interface SentMail {
  to: string;
  subject: string;
  text: string;
}

interface InviteEnv {
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string };
  db: CoreTestDb;
  adminCookie: string;
  memberCookie: string;
}

/** 真 users 表 + 签名会话；withMailConfig 决定实例形态（完整/弱化）。 */
async function envFor(withMailConfig = false): Promise<InviteEnv> {
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
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, email, role) VALUES (?, ?, ?, ?, ?, ?)',
    'u_member',
    'https://idp.example.com',
    'member-sub',
    '成员',
    'member@example.com',
    'user',
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
  const memberCookie = `unself_session=${await createSessionToken(
    { uid: 'u_member', iss: 'https://idp.example.com', sub: 'member-sub', name: '成员' },
    pair.privateKeyPem,
  )}`;
  return {
    env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem },
    db,
    adminCookie,
    memberCookie,
  };
}

/** 假 SMTP：只记录 send 消息，不触网。 */
function fakeSender(sent: SentMail[]): MailSender {
  return {
    send: async (message) => {
      sent.push({ to: message.to, subject: message.subject, text: message.text });
    },
  };
}

type TestApp = ReturnType<typeof createApp>;

/** 管理员生成邀请，返回明文 token/hash（明文只存在于邀请 URL）。 */
async function createInviteVia(
  app: TestApp,
  env: InviteEnv['env'],
  adminCookie: string,
): Promise<{ token: string; tokenHash: string; inviteUrl: string }> {
  const res = await app.request(
    'https://team.example.com/api/admin/invites',
    {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
    env,
  );
  expect(res.status).toBe(201);
  const { inviteUrl } = (await res.json()) as { inviteUrl: string };
  const token = inviteUrl.split('/invite/')[1]!;
  return { token, tokenHash: await hashOneTimeToken(token), inviteUrl };
}

/** 公开填表（默认三字段）。 */
async function submitApplication(
  app: TestApp,
  env: InviteEnv['env'],
  token: string,
  application: Record<string, string> = {
    displayName: '新人',
    emailPrefix: 'u_new',
    personalEmail: 'new@personal.example',
  },
): Promise<Response> {
  return app.request(
    `https://team.example.com/api/invite/${token}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(application),
    },
    env,
  );
}

describe('邀请域 HTTP（#18）', () => {
  it('生成邀请：明文只在 URL 里出现一次，库里存 SHA-256 与 7 天限期，落审计', async () => {
    const app = createApp();
    const { env, db, adminCookie } = await envFor();

    const res = await app.request(
      'https://team.example.com/api/admin/invites',
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(201);
    const { inviteUrl } = (await res.json()) as { inviteUrl: string };

    const token = inviteUrl.split('/invite/')[1]!;
    expect(inviteUrl).toBe(`https://team.example.com/invite/${token}`);
    expect(token.length).toBeGreaterThan(20);
    const tokenHash = await hashOneTimeToken(token);

    const row = db.first<{
      token_hash: string;
      status: string;
      days: number;
    }>(
      "SELECT token_hash, status, julianday(expires_at) - julianday(created_at) AS days FROM invites",
    );
    expect(row).toMatchObject({ token_hash: tokenHash, status: 'pending' });
    // 真库里存的必须是哈希，不是明文
    expect(row!.token_hash).not.toBe(token);
    expect(db.first<{ count: number }>('SELECT COUNT(*) AS count FROM invites WHERE token_hash = ?', token)?.count).toBe(0);
    expect(row!.days).toBeCloseTo(7, 5);

    expect(
      db.first("SELECT actor, action, target FROM audit_log WHERE action = 'invite_created'"),
    ).toEqual({ actor: 'u_admin', action: 'invite_created', target: tokenHash });

    // 有效天数越界 → 400（不发链接、不落库）
    for (const expiresInDays of [0, 366, 7.5]) {
      const bad = await app.request(
        'https://team.example.com/api/admin/invites',
        {
          method: 'POST',
          headers: { cookie: adminCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ expiresInDays }),
        },
        env,
      );
      expect(bad.status).toBe(400);
    }
    expect(db.first<{ count: number }>('SELECT COUNT(*) AS count FROM invites')?.count).toBe(1);
  });

  it('公开填表：GET 预填、POST 落库仍 pending、仅 active 管理员收到待审批站内通知', async () => {
    const app = createApp();
    const { env, db, adminCookie } = await envFor();
    db.run(
      'INSERT INTO users (id, issuer, sub, display_name, role, status) VALUES (?, ?, ?, ?, ?, ?)',
      'u_off_admin',
      'https://idp.example.com',
      'off-admin-sub',
      '停用管理',
      'admin',
      'disabled',
    );
    const { token, tokenHash } = await createInviteVia(app, env, adminCookie);

    const read = await app.request(`https://team.example.com/api/invite/${token}`, {}, env);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ displayName: '', emailPrefix: '', personalEmail: '' });

    const submitted = await submitApplication(app, env, token, {
      displayName: ' 新人 ',
      emailPrefix: ' u_new ',
      personalEmail: ' new@personal.example ',
    });
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual({ ok: true });

    expect(
      db.first(
        'SELECT status, display_name, email_prefix, personal_email FROM invites WHERE token_hash = ?',
        tokenHash,
      ),
    ).toEqual({
      status: 'pending',
      display_name: '新人',
      email_prefix: 'u_new',
      personal_email: 'new@personal.example',
    });

    const prefilled = await app.request(`https://team.example.com/api/invite/${token}`, {}, env);
    expect(await prefilled.json()).toEqual({
      displayName: '新人',
      emailPrefix: 'u_new',
      personalEmail: 'new@personal.example',
    });

    const notifications = db.query<{ user_id: string | null; type: string; payload: string }>(
      "SELECT user_id, type, payload FROM notifications WHERE type = 'invite_pending' ORDER BY user_id",
    );
    expect(notifications.map((row) => row.user_id)).toEqual(['u_admin']);
    expect(JSON.parse(notifications[0]!.payload)).toEqual({
      name: '新人',
      emailPrefix: 'u_new',
      personalEmail: 'new@personal.example',
    });

    // 管理端列表形状：due 等内部判定列不进 API
    const list = await app.request(
      'https://team.example.com/api/admin/invites',
      { headers: { cookie: adminCookie } },
      env,
    );
    expect(list.status).toBe(200);
    const invites = (await list.json()) as Array<Record<string, unknown>>;
    expect(invites).toHaveLength(1);
    expect(Object.keys(invites[0]!).sort()).toEqual([
      'created_at',
      'display_name',
      'email_prefix',
      'expires_at',
      'personal_email',
      'status',
      'token_hash',
    ]);
    expect(invites[0]).toMatchObject({
      token_hash: tokenHash,
      status: 'pending',
      display_name: '新人',
      email_prefix: 'u_new',
      personal_email: 'new@personal.example',
    });

    // 表单非法（空显示名 / 前缀带 @ / 邮箱不合法）→ 400 且不改库
    for (const bad of [
      { displayName: '', emailPrefix: 'u_new', personalEmail: 'new@personal.example' },
      { displayName: '新人', emailPrefix: 'u@new', personalEmail: 'new@personal.example' },
      { displayName: '新人', emailPrefix: 'u_new', personalEmail: 'not-an-email' },
    ]) {
      expect((await submitApplication(app, env, token, bad)).status).toBe(400);
    }
    expect(
      db.first<{ display_name: string }>(
        'SELECT display_name FROM invites WHERE token_hash = ?',
        tokenHash,
      ),
    ).toEqual({ display_name: '新人' });
  });

  it('弱化实例：批准只置 approved，不发激活邮件，首登按个人邮箱消费', async () => {
    const sent: SentMail[] = [];
    const app = createApp({
      createMailProvisioner: () => {
        throw new Error('mail provisioner must stay unconstructed');
      },
      createMailSender: () => fakeSender(sent),
    });
    const { env, db, adminCookie } = await envFor();
    const { token, tokenHash } = await createInviteVia(app, env, adminCookie);
    expect((await submitApplication(app, env, token)).status).toBe(200);

    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ status: 'approved', email: null });

    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'approved',
    });
    expect(db.first<{ count: number }>('SELECT COUNT(*) AS count FROM invite_activations')).toEqual({
      count: 0,
    });
    expect(db.query("SELECT id FROM notifications WHERE type = 'account_ready'")).toEqual([]);
    expect(sent).toEqual([]);

    // invite_result 对个人邮箱悬挂（未建档，user_id IS NULL）
    const results = db.query<{ user_id: string | null; invited_email: string | null; payload: string }>(
      "SELECT user_id, invited_email, payload FROM notifications WHERE type = 'invite_result'",
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ user_id: null, invited_email: 'new@personal.example' });
    expect(JSON.parse(results[0]!.payload)).toEqual({
      approved: true,
      name: '新人',
      approver: '管理',
    });
    expect(
      db.first("SELECT actor, action, target FROM audit_log WHERE action = 'invite_approved'"),
    ).toEqual({ actor: 'u_admin', action: 'invite_approved', target: tokenHash });

    // 重复批准：终态守卫（detail 是人话）
    const again = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(again.status).toBe(409);
    const againBody = (await again.json()) as { error: string; detail: string };
    expect(againBody.error).toBe('invite not pending');
    expect(againBody.detail).toContain('已批准');

    // 首登真链（OIDC 回调接线由 auth-routes.test.ts #49 覆盖；这里只测消费函数）
    await expect(consumeApprovedInviteByEmail(db.d1, 'u_new', 'new@personal.example')).resolves.toBe(
      'consumed',
    );
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'consumed',
    });
  });

  it('完整实例前缀被占用：409 可恢复，邀请保持 pending 且不签激活令牌', async () => {
    const provisioner = createFakeMailProvisioner();
    provisioner.accounts.set('u_new@example.com', {
      displayName: '已有账户',
      disabled: false,
      password: 'x',
    });
    const app = createApp({ createMailProvisioner: () => provisioner });
    const { env, db, adminCookie } = await envFor(true);
    const { token, tokenHash } = await createInviteVia(app, env, adminCookie);
    expect((await submitApplication(app, env, token)).status).toBe(200);

    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(approved.status).toBe(409);
    const body = (await approved.json()) as { error: string; detail: string };
    expect(body.error).toBe('invite approve failed');
    expect(body.detail).toContain('已被占用');
    expect(body.detail).toContain('u_new');

    expect(provisioner.calls).toEqual([
      { method: 'createAccount', input: { emailPrefix: 'u_new', displayName: '新人' } },
    ]);
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'pending',
    });
    expect(db.first<{ count: number }>('SELECT COUNT(*) AS count FROM invite_activations')).toEqual({
      count: 0,
    });
    expect(db.query("SELECT id FROM notifications WHERE type = 'account_ready'")).toEqual([]);
  });

  it('开户失败零成员落库（#114）：OIDC 路径无成员行、邀请保持 pending、响应含人话 detail', async () => {
    const provisioner = createFakeMailProvisioner();
    provisioner.createAccount = async () => {
      // #115 认证失败轴：HTTP 401/403 → 502 + 「检查 API Key」指引
      throw new Error('Stalwart JMAP 请求失败：HTTP 401 Unauthorized');
    };
    const app = createApp({ createMailProvisioner: () => provisioner });
    const { env, db, adminCookie } = await envFor(true);
    const { token, tokenHash } = await createInviteVia(app, env, adminCookie);
    expect((await submitApplication(app, env, token)).status).toBe(200);

    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(approved.status).toBe(502);
    const body = (await approved.json()) as { error: string; detail: string };
    expect(body.error).toBe('invite approve failed');
    expect(body.detail).toContain('邮箱开户失败');
    expect(body.detail).toContain('检查 API Key');
    expect(body.detail).toContain('邀请保持待审批');

    // 零成员落库：开户失败时 users/builtin_credentials 均无新增行
    expect(db.first<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE issuer = 'builtin'")?.count).toBe(0);
    expect(db.first<{ count: number }>('SELECT COUNT(*) AS count FROM builtin_credentials')).toEqual({
      count: 0,
    });
    // 邀请保持 pending 可重批；无激活令牌、无任何通知与审计
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'pending',
    });
    expect(db.first<{ count: number }>('SELECT COUNT(*) AS count FROM invite_activations')).toEqual({
      count: 0,
    });
    expect(db.query("SELECT id FROM notifications WHERE type IN ('account_ready', 'invite_result')")).toEqual([]);
    expect(db.first<{ count: number }>("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'invite_approved'")?.count).toBe(0);

    // 重批时开户会再试一次：这次成功则正常走完（pending → approved）
    provisioner.createAccount = createFakeMailProvisioner().createAccount;
    const retried = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(retried.status).toBe(200);
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'approved',
    });
    expect(db.first<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE issuer = 'builtin'")?.count).toBe(0);
  });

  it('开户失败分类（#115）：ACCOUNT_NOT_FOUND → 409 人话指向 Stalwart 后台，#114 语义（零落库/pending）不回退', async () => {
    const provisioner = createFakeMailProvisioner();
    provisioner.createAccount = async () => {
      throw new MailProvisionerError('ACCOUNT_NOT_FOUND', 'Stalwart 中找不到账户 u_new@example.com');
    };
    const app = createApp({ createMailProvisioner: () => provisioner });
    const { env, db, adminCookie } = await envFor(true);
    const { token, tokenHash } = await createInviteVia(app, env, adminCookie);
    expect((await submitApplication(app, env, token)).status).toBe(200);

    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(approved.status).toBe(409);
    const body = (await approved.json()) as { error: string; detail: string };
    expect(body.error).toBe('invite approve failed');
    expect(body.detail).toContain('Stalwart 中无此邮箱账号');
    // approve 时工作邮箱域名还在 provisioner 配置里，detail 只能定位到邮箱前缀
    expect(body.detail).toContain('（u_new）');

    // #114 语义不回退：零成员落库、邀请保持 pending、无激活令牌与通知
    expect(db.first<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE issuer = 'builtin'")?.count).toBe(0);
    expect(db.first<{ count: number }>('SELECT COUNT(*) AS count FROM builtin_credentials')).toEqual({
      count: 0,
    });
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'pending',
    });
    expect(db.first<{ count: number }>('SELECT COUNT(*) AS count FROM invite_activations')).toEqual({
      count: 0,
    });
    expect(db.query("SELECT id FROM notifications WHERE type IN ('account_ready', 'invite_result')")).toEqual([]);
  });

  it('开户失败零成员落库（#114）：内置注册路径不落 users/builtin_credentials，重批成功后落行', async () => {
    const provisioner = createFakeMailProvisioner();
    provisioner.createAccount = async () => {
      throw new Error('Stalwart 请求失败');
    };
    const sent: SentMail[] = [];
    const app = createApp({
      createMailProvisioner: () => provisioner,
      createMailSender: () => fakeSender(sent),
    });
    const { env, db, adminCookie } = await envFor(true);
    const { token, tokenHash } = await createInviteVia(app, env, adminCookie);
    // 内置注册：pk1 盐+R 形状任意字符串即可（本单不验协议，只验成员行与状态顺序）
    const applied = await app.request(
      `https://team.example.com/api/invite/${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '新人',
          emailPrefix: 'u_new',
          personalEmail: 'new@personal.example',
          username: 'grace',
          salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
          proof: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        }),
      },
      env,
    );
    expect(applied.status).toBe(200);

    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(approved.status).toBe(502);
    const body = (await approved.json()) as { error: string; detail: string };
    expect(body.detail).toContain('邮箱开户失败');
    expect(body.detail).toContain('邀请保持待审批');

    // 核心断言：开户失败时成员行零落库（旧顺序此处必然有行 = 可登录幽灵）
    expect(db.first<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE issuer = 'builtin'")?.count).toBe(0);
    expect(db.first<{ count: number }>('SELECT COUNT(*) AS count FROM builtin_credentials')).toEqual({
      count: 0,
    });
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'pending',
    });
    expect(sent).toEqual([]);

    // 重批：开户成功后才落成员行，邀请 approved，登录链路可用
    provisioner.createAccount = createFakeMailProvisioner().createAccount;
    const retried = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(retried.status).toBe(200);
    expect(db.first<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE issuer = 'builtin'")?.count).toBe(1);
    expect(db.first<{ username: string }>('SELECT username FROM builtin_credentials')?.username).toBe('grace');
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'approved',
    });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.subject).toContain('账号已开通');
    expect(sent[1]!.subject).toContain('加入申请已通过');
  });

  it('内置路径用户名撞 UNIQUE（#114 重排后发生在开户之后）：409 + detail 提示 Stalwart 已预创建', async () => {
    const provisioner = createFakeMailProvisioner();
    const app = createApp({ createMailProvisioner: () => provisioner });
    const { env, db, adminCookie } = await envFor(true);

    // 先落一个同名内置用户（模拟已批准的另一申请）
    const first = await createInviteVia(app, env, adminCookie);
    expect(
      (
        await app.request(
          `https://team.example.com/api/invite/${first.token}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              displayName: '先来者',
              emailPrefix: 'u_first',
              personalEmail: 'first@personal.example',
              username: 'heidi',
              salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
              proof: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            }),
          },
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `https://team.example.com/api/admin/invites/${first.tokenHash}/approve`,
          { method: 'POST', headers: { cookie: adminCookie } },
          env,
        )
      ).status,
    ).toBe(200);

    // 绕开软闸制造同名第二申请（同 builtin-auth.test 的 TOCTOU 窗口手法：
    // 提交时用不重名，随后在库内改名为 heidi，模拟并发窗口下的双 pending 同名）
    const second = await createInviteVia(app, env, adminCookie);
    expect(
      (
        await app.request(
          `https://team.example.com/api/invite/${second.token}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              displayName: '新人',
              emailPrefix: 'u_new',
              personalEmail: 'new@personal.example',
              username: 'voldemort',
              salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
              proof: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            }),
          },
          env,
        )
      ).status,
    ).toBe(200);
    db.run('UPDATE invite_credentials SET username = ? WHERE username = ?', 'heidi', 'voldemort');

    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${second.tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(approved.status).toBe(409);
    const body = (await approved.json()) as { error: string; detail: string };
    expect(body.detail).toContain('已被占用');
    expect(body.detail).toContain('邮箱账号已预创建');
    // 重排后硬闸发生在开户之后：Stalwart 已建号（u_new@example.com）
    expect(provisioner.accounts.has('u_new@example.com')).toBe(true);
    // 邀请仍 pending，本单不做回滚
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', second.tokenHash)).toEqual({
      status: 'pending',
    });
  });

  it('过期邀请：公开读取/提交 410，惰性置 expired，审批 409', async () => {
    const app = createApp();
    const { env, db, adminCookie } = await envFor();
    const { token, tokenHash } = await createInviteVia(app, env, adminCookie);
    db.run("UPDATE invites SET expires_at = datetime('now', '-1 hour') WHERE token_hash = ?", tokenHash);

    const submitted = await submitApplication(app, env, token);
    expect(submitted.status).toBe(410);
    expect(await submitted.json()).toEqual({ error: '邀请链接已过期或已被使用' });
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'expired',
    });

    const read = await app.request(`https://team.example.com/api/invite/${token}`, {}, env);
    expect(read.status).toBe(410);

    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(approved.status).toBe(409);
    expect(((await approved.json()) as { detail: string }).detail).toContain('已过期');
  });

  it('拒绝闭环：未填表撤销不通知（无收件人），已填表拒绝落结果通知与审计', async () => {
    const sent: SentMail[] = [];
    const app = createApp({ createMailSender: () => fakeSender(sent) });
    const { env, db, adminCookie } = await envFor();
    const { tokenHash } = await createInviteVia(app, env, adminCookie);

    // 未填表先批准 → 409（缺邮箱前缀，无法开户）
    const tooEarly = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(tooEarly.status).toBe(409);
    expect((await tooEarly.json()) as { error: string }).toMatchObject({ error: 'invite not filled' });

    // 未填表可拒绝（撤销入口）
    const rejected = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/reject`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toEqual({ status: 'rejected' });
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'rejected',
    });

    const results = db.query<{ payload: string }>(
      "SELECT payload FROM notifications WHERE type = 'invite_result'",
    );
    // 未填表：没有个人邮箱可发，不落空收件人通知
    expect(results).toHaveLength(0);
    expect(
      db.first("SELECT actor, action, target FROM audit_log WHERE action = 'invite_rejected'"),
    ).toEqual({ actor: 'u_admin', action: 'invite_rejected', target: tokenHash });

    // 已填表拒绝：结果通知悬挂到申请人个人邮箱
    const filled = await createInviteVia(app, env, adminCookie);
    expect((await submitApplication(app, env, filled.token)).status).toBe(200);
    const rejectFilled = await app.request(
      `https://team.example.com/api/admin/invites/${filled.tokenHash}/reject`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(rejectFilled.status).toBe(200);
    expect(
      db.query<{ invited_email: string; payload: string }>(
        "SELECT invited_email, payload FROM notifications WHERE type = 'invite_result'",
      ),
    ).toEqual([
      {
        invited_email: 'new@personal.example',
        payload: JSON.stringify({ approved: false, name: '新人', approver: '管理' }),
      },
    ]);

    const approveRejected = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(approveRejected.status).toBe(409);
    expect(((await approveRejected.json()) as { detail: string }).detail).toContain('已拒绝');
  });

  it('鉴权边界：公开端点错令牌 404，管理端点无会话 401、普通成员 403', async () => {
    const app = createApp();
    const { env, adminCookie, memberCookie } = await envFor();

    expect(
      (await app.request('https://team.example.com/api/invite/wrong-token', {}, env)).status,
    ).toBe(404);
    expect((await submitApplication(app, env, 'wrong-token')).status).toBe(404);

    expect(
      (await app.request('https://team.example.com/api/admin/invites', {}, env)).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          'https://team.example.com/api/admin/invites',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          },
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (await app.request('https://team.example.com/api/admin/invites', { headers: { cookie: memberCookie } }, env)).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          'https://team.example.com/api/admin/invites/abc/approve',
          { method: 'POST', headers: { cookie: memberCookie } },
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          'https://team.example.com/api/admin/invites/abc/reject',
          { method: 'POST', headers: { cookie: memberCookie } },
          env,
        )
      ).status,
    ).toBe(403);

    // admin 正常放行（存在性语义：不存在的 id → 404 而非 401/403）
    expect(
      (
        await app.request(
          'https://team.example.com/api/admin/invites/abc/approve',
          { method: 'POST', headers: { cookie: adminCookie } },
          env,
        )
      ).status,
    ).toBe(404);
  });
});
