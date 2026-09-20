// SPDX-License-Identifier: AGPL-3.0-only
import type { MailProvisioner } from '@unself/contracts';
import { MailProvisionerError } from '@unself/contracts';
import type { MailMessage } from '@unself/mail-smtp';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { hashOneTimeToken } from '../src/one-time-token';
import { createSessionToken } from '../src/session';
import { createCoreDb, type CoreTestDb } from './test-factory';

const helloManifest = {
  id: 'hello',
  route: '/m/hello',
  entry: 'https://team.example.com/m/hello/',
  runtimes: ['worker'],
  version: '1.0.0',
};

interface MemberTestEnv {
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string };
  db: CoreTestDb;
  adminCookie: string;
  memberCookie: string;
}

/** 真 users 表 + 两个签名会话，权限真值始终来自同一 SQLite 库。 */
async function envFor(): Promise<MemberTestEnv> {
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
  const adminToken = await createSessionToken(
    { uid: 'u_admin', iss: 'https://idp.example.com', sub: 'admin-sub', name: '管理' },
    pair.privateKeyPem,
  );
  const memberToken = await createSessionToken(
    { uid: 'u_member', iss: 'https://idp.example.com', sub: 'member-sub', name: '成员' },
    pair.privateKeyPem,
  );
  return {
    env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem },
    db,
    adminCookie: `unself_session=${adminToken}`,
    memberCookie: `unself_session=${memberToken}`,
  };
}

function seedHello(db: CoreTestDb): void {
  db.run(
    'INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES (?, ?, ?, ?)',
    'hello',
    1,
    helloManifest.version,
    JSON.stringify(helloManifest),
  );
}

function fakeProvisioner(calls: string[]): MailProvisioner {
  return {
    createAccount: async () => ({ email: 'created@example.com' }),
    disableAccount: async ({ email }) => {
      calls.push(`disable:${email}`);
    },
    enableAccount: async ({ email }) => {
      calls.push(`enable:${email}`);
    },
    resetPassword: async () => undefined,
  };
}

/** 完整 SMTP 段（settings 契约；不注入假 sender 时足以装配真发信口）。 */
const FULL_MAIL_CONFIG = {
  host: 'smtp.example.com',
  port: 465,
  username: 'bot',
  password: 'secret',
  from: 'no-reply@example.com',
};

describe('管理端成员生命周期（#49）', () => {
  it('管理员读取全量成员字段；普通成员不能访问管理域', async () => {
    const app = createApp();
    const { env, db, adminCookie, memberCookie } = await envFor();
    db.run(
      'INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)',
      'u_no_email',
      'https://idp.example.com',
      'no-email-sub',
      '无邮箱成员',
      'user',
    );

    const res = await app.request(
      'https://team.example.com/api/admin/members',
      { headers: { cookie: adminCookie } },
      env,
    );
    expect(res.status).toBe(200);
    const members = (await res.json()) as Array<Record<string, unknown>>;
    const noEmail = members.find((member) => member.id === 'u_no_email');
    expect(noEmail).toMatchObject({
      id: 'u_no_email',
      display_name: '无邮箱成员',
      email: null,
      status: 'active',
      role: 'user',
      created_at: expect.any(String),
    });
    expect(Object.keys(noEmail ?? {}).sort()).toEqual([
      'created_at',
      'display_name',
      'email',
      'id',
      'role',
      'status',
    ]);

    const member = await app.request(
      'https://team.example.com/api/admin/members',
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(member.status).toBe(403);
  });

  it('完整实例停用和启用联动 provisioner，并即时收回和恢复会话权限', async () => {
    const calls: string[] = [];
    const mailConfigs: unknown[] = [];
    const app = createApp({
      createMailProvisioner: (config) => {
        mailConfigs.push(config);
        return fakeProvisioner(calls);
      },
    });
    const { env, db, adminCookie, memberCookie } = await envFor();
    db.run(
      'INSERT INTO instance_config (key, value) VALUES (?, ?)',
      'mail',
      JSON.stringify({ provider: 'fake' }),
    );
    seedHello(db);

    const disabled = await app.request(
      'https://team.example.com/api/admin/members/u_member/disable',
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ id: 'u_member', status: 'disabled' });
    expect(db.first<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u_member')).toEqual({
      status: 'disabled',
    });
    expect(calls).toEqual(['disable:member@example.com']);

    const disabledMe = await app.request(
      'https://team.example.com/api/me',
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(disabledMe.status).toBe(403);
    const disabledToken = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie: memberCookie } },
      env,
    );
    expect(disabledToken.status).toBe(403);

    const enabled = await app.request(
      'https://team.example.com/api/admin/members/u_member/enable',
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({ id: 'u_member', status: 'active' });
    expect(calls).toEqual(['disable:member@example.com', 'enable:member@example.com']);
    expect(mailConfigs).toEqual([{ provider: 'fake' }, { provider: 'fake' }]);
    expect(
      db.query<{ actor: string; action: string; target: string }>(
        "SELECT actor, action, target FROM audit_log WHERE action LIKE 'member_%' ORDER BY id",
      ),
    ).toEqual([
      { actor: 'u_admin', action: 'member_disabled', target: 'u_member' },
      { actor: 'u_admin', action: 'member_enabled', target: 'u_member' },
    ]);

    const restoredMe = await app.request(
      'https://team.example.com/api/me',
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(restoredMe.status).toBe(200);
    const restoredToken = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie: memberCookie } },
      env,
    );
    expect(restoredToken.status).toBe(200);
  });

  it('弱化实例不构建 provisioner，仍可翻转成员状态', async () => {
    const calls: string[] = [];
    const app = createApp({
      createMailProvisioner: () => {
        throw new Error('mail provisioner must stay unconstructed');
      },
    });
    const { env, db, adminCookie } = await envFor();

    expect(
      (
        await app.request(
          'https://team.example.com/api/admin/members/u_member/disable',
          { method: 'POST', headers: { cookie: adminCookie } },
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          'https://team.example.com/api/admin/members/u_member/enable',
          { method: 'POST', headers: { cookie: adminCookie } },
          env,
        )
      ).status,
    ).toBe(200);
    expect(db.first<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u_member')).toEqual({
      status: 'active',
    });
    expect(calls).toEqual([]);
  });

  it('邮件轴联动失败不再裸 500（#115/#189）：结构化 code 优先，裸错误文案兜底，超时→502 人话', async () => {
    const calls: string[] = [];
    const errors: unknown[] = [
      new MailProvisionerError('ACCOUNT_NOT_FOUND', 'Stalwart 中找不到账户 member@example.com'),
      // #189 B1：结构化判定——文案怎么改都不影响认证失败分类（不再靠 /HTTP 40[13]/ 嗅探）
      new MailProvisionerError('AUTH_FAILED', '上游拒绝：文案已改（HTTP 状态在结构化字段里）', {
        httpStatus: 403,
      }),
      // #189 B5：超时归类为 TIMEOUT，折叠成 502 人话，不把英文/裸原因甩给用户
      new MailProvisionerError(
        'TIMEOUT',
        'Stalwart JMAP disableAccount 调用超时：超过 10s 未响应',
      ),
      // 旧口径兑底：未结构化的实现仍按文案分类（兼容存量第三方实现）
      new Error('Stalwart JMAP 请求失败：HTTP 401 Unauthorized'),
      new Error('Stalwart JMAP 请求失败（网络错误）：https://mail.example.com/jmap'),
    ];
    const expected = [
      { status: 409, detailPart: 'Stalwart 中无此邮箱账号（member@example.com）' },
      { status: 502, detailPart: '检查 API Key' },
      { status: 502, detailPart: '未在时限内响应' },
      { status: 502, detailPart: '检查 API Key' },
      { status: 502, detailPart: 'Stalwart JMAP 请求失败（网络错误）' },
    ];
    let i = 0;
    const flakyProvisioner: MailProvisioner = {
      createAccount: async () => ({ email: 'created@example.com' }),
      disableAccount: async () => {
        throw errors[i]!;
      },
      enableAccount: async () => {
        throw errors[i]!;
      },
      resetPassword: async () => undefined,
    };
    const app = createApp({
      createMailProvisioner: () => flakyProvisioner,
    });
    const { env, db, adminCookie } = await envFor();
    db.run(
      'INSERT INTO instance_config (key, value) VALUES (?, ?)',
      'mail',
      JSON.stringify({ provider: 'fake' }),
    );

    for (let step = 0; step < errors.length; step++) {
      // disable：五类错误 → 409 / 502 三种人话，detail 人话且不含英文裸原因
      const disabled = await app.request(
        'https://team.example.com/api/admin/members/u_member/disable',
        { method: 'POST', headers: { cookie: adminCookie } },
        env,
      );
      expect(disabled.status).toBe(expected[step]!.status);
      const disabledBody = (await disabled.json()) as { error: string; detail: string };
      expect(disabledBody.error).toBe('member sync failed');
      expect(disabledBody.detail).toContain(expected[step]!.detailPart);

      // 状态翻转已落库：成员已 disabled（不回滚），enable 同类错误同映射
      expect(
        db.first<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u_member'),
      ).toEqual({ status: 'disabled' });

      const enabled = await app.request(
        'https://team.example.com/api/admin/members/u_member/enable',
        { method: 'POST', headers: { cookie: adminCookie } },
        env,
      );
      expect(enabled.status).toBe(expected[step]!.status);
      const enabledBody = (await enabled.json()) as { error: string; detail: string };
      expect(enabledBody.error).toBe('member sync failed');
      expect(enabledBody.detail).toContain(expected[step]!.detailPart);
      expect(
        db.first<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u_member'),
      ).toEqual({ status: 'active' });

      i = step + 1;
    }
    // 审计只在成员动作起点落过一次（disable 成功于首次翻转前已落）；此处只保证联动异常后不误报 enable 审计
    expect(calls).toEqual([]);

    // #188 S5：失败联动逐次落 audit（方向 + 操作人 + 目标邮箱 + 错误分类），成功路径不受影响
    const failureRows = db.query<{ actor: string; action: string; target: string | null }>(
      "SELECT actor, action, target FROM audit_log WHERE action IN ('member_disable_failed', 'member_enable_failed') ORDER BY id",
    );
    expect(failureRows).toHaveLength(10);
    expect(failureRows.map((row) => row.action)).toEqual([
      'member_disable_failed',
      'member_enable_failed',
      'member_disable_failed',
      'member_enable_failed',
      'member_disable_failed',
      'member_enable_failed',
      'member_disable_failed',
      'member_enable_failed',
      'member_disable_failed',
      'member_enable_failed',
    ]);
    expect(failureRows.every((row) => row.actor === 'u_admin')).toBe(true);
    expect(failureRows.every((row) => row.target?.includes('member@example.com'))).toBe(true);
    // 五类错误分类都进 target 文本（409 账户不存在 / 502 认证（结构化+兑底）/ 502 超时 / 502 其它）
    expect(failureRows[0]?.target).toContain('HTTP 409');
    expect(failureRows[0]?.target).toContain('Stalwart 中找不到账户');
    expect(failureRows[4]?.target).toContain('HTTP 502');
    expect(failureRows[4]?.target).toContain('调用超时');
    expect(failureRows[6]?.target).toContain('HTTP 502');
    expect(failureRows[6]?.target).toContain('HTTP 401 Unauthorized');
    expect(failureRows[8]?.target).toContain('网络错误');
    // 状态翻转的成功审计仍在（失败审计是额外一行，不替掉原行）
    expect(
      db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM audit_log WHERE action IN ('member_disabled', 'member_enabled')",
      ),
    ).toEqual({ count: 10 });
  });

  it('#188 S4：重发激活邮件：站内 payload 只有脱敏标记，邮件正文拿到真链接（重签旧令牌作废）', async () => {
    const sent: MailMessage[] = [];
    const app = createApp({
      createMailSender: () => ({
        send: async (message: MailMessage) => {
          sent.push(message);
        },
      }),
    });
    const { env, db, adminCookie } = await envFor();
    db.run(
      'INSERT INTO instance_config (key, value) VALUES (?, ?)',
      'mail',
      JSON.stringify(FULL_MAIL_CONFIG),
    );
    // 内置登录成员 + 已批准的邀请 + 一条待用激活令牌（重发前状态）
    db.run(
      "UPDATE users SET issuer = 'builtin', personal_email = 'newbie@personal.example' WHERE id = 'u_member'",
    );
    const oldTokenHash = await hashOneTimeToken('old-token-plaintext');
    db.run(
      "INSERT INTO invites (token_hash, status, personal_email, email_prefix, display_name, expires_at) VALUES ('invite-hash-1', 'approved', 'newbie@personal.example', 'newbie', '新人', datetime('now', '+1 day'))",
    );
    db.run(
      "INSERT INTO invite_activations (token_hash, invite_token_hash, email, expires_at) VALUES (?, 'invite-hash-1', 'newbie@example.com', datetime('now', '+1 day'))",
      oldTokenHash,
    );

    const res = await app.request(
      'https://team.example.com/api/admin/members/u_member/resend-activation',
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // 站内行：悬挂在邀请邮箱下，payload 只有收件人 + 脱敏标记
    const rows = db.query<{ payload: string; invited_email: string; user_id: string | null }>(
      "SELECT payload, invited_email, user_id FROM notifications WHERE type = 'account_ready'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invited_email: 'newbie@personal.example', user_id: null });
    expect(Object.keys(JSON.parse(rows[0]!.payload) as Record<string, unknown>).sort()).toEqual([
      'activateLinkGenerated',
      'email',
    ]);
    expect(rows[0]?.payload).not.toMatch(/https?:\/\/|\/activate\/|old-token-plaintext/);

    // 邮件：链接照旧可用的真令牌——明文只在邮件正文里，库里只有哈希（且是重签后的新行）
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('newbie@personal.example');
    const linkToken = /\/activate\/(\S+)/.exec(sent[0]?.text ?? '')?.[1];
    expect(linkToken).toBeTruthy();
    expect(
      db.first(
        'SELECT email, used_at FROM invite_activations WHERE token_hash = ?',
        await hashOneTimeToken(linkToken!),
      ),
    ).toEqual({ email: 'newbie@example.com', used_at: null });
    expect(
      db.first<{ used_at: string }>(
        'SELECT used_at FROM invite_activations WHERE token_hash = ?',
        oldTokenHash,
      )?.used_at,
    ).toMatch(/^invalidated@/);
    // 库里没有明文令牌（站内 payload 与库全表都不含邮件里的那串）
    expect(
      db
        .query<{ payload: string }>('SELECT payload FROM notifications')
        .some((row) => row.payload.includes(linkToken!)),
    ).toBe(false);
    expect(db.first('SELECT actor, action FROM audit_log WHERE action = ?', 'activation_resent')).toEqual(
      {
        actor: 'u_admin',
        action: 'activation_resent',
      },
    );
  });

  it('admin 守卫拒绝普通成员，setup-token 公开签发口已删（#165）', async () => {
    const app = createApp();
    const { env, db, memberCookie } = await envFor();

    const member = await app.request(
      'https://team.example.com/api/admin/members/u_admin/disable',
      { method: 'POST', headers: { cookie: memberCookie } },
      env,
    );
    expect(member.status).toBe(403);
    expect(db.first<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u_admin')).toEqual({
      status: 'active',
    });

    // #165：公开签发口已删 —— 无会话请求被 adminGuard 接管（旧实现显式豁免此路径）
    const setupToken = await app.request(
      'https://team.example.com/api/admin/setup-token',
      { method: 'POST' },
      env,
    );
    expect(setupToken.status).toBe(401);
  });
});

/**
 * 应用密码说明页的成员能力（#168）：/api/me 的 mailEnabled + mailPortalUrl。
 * 成员态可达（非 admin）是刻意为之——说明页是成员功能，不是管理功能；
 * mailPortalUrl 是服务端解析好的最终跳转目标（portalUrl 优先，domain 推导兜底）。
 */
describe('应用密码说明页能力（#168）', () => {
  it('mail 段配了 portalUrl：成员拿到的 mailEnabled=true + mailPortalUrl=portalUrl（优先于 domain 推导）', async () => {
    const app = createApp();
    const { env, db, memberCookie } = await envFor();
    db.run(
      'INSERT INTO instance_config (key, value) VALUES (?, ?)',
      'mail',
      JSON.stringify({ domain: 'example.com', portalUrl: 'https://portal.example.com/app-passwords' }),
    );

    const res = await app.request(
      'https://team.example.com/api/me',
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mailEnabled: boolean; mailPortalUrl: string | null };
    expect(body.mailEnabled).toBe(true);
    expect(body.mailPortalUrl).toBe('https://portal.example.com/app-passwords');
  });

  it('mail 段只有 domain：mailPortalUrl 推导为 https://mail.<domain>', async () => {
    const app = createApp();
    const { env, db, memberCookie } = await envFor();
    db.run(
      'INSERT INTO instance_config (key, value) VALUES (?, ?)',
      'mail',
      JSON.stringify({ domain: 'example.com', host: 'smtp.example.com' }),
    );

    const res = await app.request(
      'https://team.example.com/api/me',
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mailEnabled: boolean; mailPortalUrl: string | null };
    expect(body.mailEnabled).toBe(true);
    expect(body.mailPortalUrl).toBe('https://mail.example.com');
  });

  it('mail 段两者都缺：轴开但 mailPortalUrl=null（说明页只禁用跳转，不是关闭轴）', async () => {
    const app = createApp();
    const { env, db, memberCookie } = await envFor();
    db.run(
      'INSERT INTO instance_config (key, value) VALUES (?, ?)',
      'mail',
      JSON.stringify({ baseUrl: 'https://mail.example.com', apiKey: 'k' }),
    );

    const res = await app.request(
      'https://team.example.com/api/me',
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mailEnabled: boolean; mailPortalUrl: string | null };
    expect(body.mailEnabled).toBe(true);
    expect(body.mailPortalUrl).toBeNull();
  });

  it('邮件轴关闭 / 无 mail 行：mailEnabled=false 且不给门户地址（不误导）', async () => {
    const app = createApp();
    const { env, db, memberCookie } = await envFor();
    db.run(
      'INSERT INTO instance_config (key, value) VALUES (?, ?)',
      'mail',
      JSON.stringify({ domain: 'example.com', enabled: false }),
    );

    const off = await app.request(
      'https://team.example.com/api/me',
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ mailEnabled: false, mailPortalUrl: null });

    // 无 mail 行（弱化实例）同口径：仍可登录，只是没有邮件能力。
    const weak = await envFor();
    const weakRes = await createApp().request(
      'https://team.example.com/api/me',
      { headers: { cookie: weak.memberCookie } },
      weak.env,
    );
    expect(weakRes.status).toBe(200);
    expect(await weakRes.json()).toMatchObject({ mailEnabled: false, mailPortalUrl: null });
  });
});
