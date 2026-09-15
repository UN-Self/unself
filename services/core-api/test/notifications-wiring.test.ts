// SPDX-License-Identifier: AGPL-3.0-only
import type { MailMessage } from '@unself/mail-smtp';
import { describe, expect, it, vi } from 'vitest';

import { createApp, type CoreApiDependencies } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { hashOneTimeToken } from '../src/one-time-token';
import { createSessionToken } from '../src/session';
import { createCoreDb } from './test-factory';

/**
 * #19 触发点接线集成（主会话归属）：模块启停 TODO(#19) 占位处 → module_toggled 广播。
 * 行为口径：全员 active 成员各落一条站内通知（含操作者本人），disabled 不收；
 * payload 带 moduleId/enabled；mail 段未装配不报错（module_toggled 渠道位本就只站内）。
 * #167：mail.enabled=false 时发信工厂根本不被装配（邀请→批准→模块启停全链零发信尝试）。
 */
async function envFor(dependencies?: CoreApiDependencies) {
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
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, role, status) VALUES (?, ?, ?, ?, ?, ?)',
    'u_off',
    'https://idp.example.com',
    'off-sub',
    '停用成员',
    'user',
    'disabled',
  );
  db.run(
    "INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES ('hello', 1, '1.0.0', '{}')",
  );
  const adminToken = await createSessionToken(
    { uid: 'u_admin', iss: 'https://idp.example.com', sub: 'admin-sub', name: '管理' },
    pair.privateKeyPem,
  );
  return {
    app: createApp(dependencies),
    env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem },
    db,
    adminCookie: `unself_session=${adminToken}`,
  };
}

describe('模块启停 → module_toggled 广播（#19 接线）', () => {
  it('翻转启停给每个 active 成员落站内通知，disabled 不收', async () => {
    const { app, env, db, adminCookie } = await envFor();

    const res = await app.request(
      'https://team.example.com/api/admin/modules/hello/toggle',
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const rows = db.query<{ user_id: string; type: string; payload: string; is_read: number }>(
      'SELECT user_id, type, payload, is_read FROM notifications ORDER BY user_id',
    );
    expect(rows.map((row) => row.user_id)).toEqual(['u_admin', 'u_member']);
    for (const row of rows) {
      expect(row.type).toBe('module_toggled');
      expect(JSON.parse(row.payload)).toEqual({ moduleId: 'hello', enabled: false });
      expect(row.is_read).toBe(0);
    }
  });
});

/** 完整 mail 段（与 settings 路由契约一致，SMTP 字段齐全）：关开关 ≠ 删行。 */
const FULL_MAIL_CONFIG = {
  baseUrl: 'https://mail.example.com',
  apiKey: 'k',
  domain: 'example.com',
  host: 'smtp.example.com',
  port: 465,
  username: 'u',
  password: 'p',
  from: 'no-reply@example.com',
};

describe('#188 S4：account_ready 落库脱敏（批准真链路）', () => {
  it('批准开号：站内 payload 只有脱敏标记，邮件正文拿到库里可用的激活链接', async () => {
    const sent: MailMessage[] = [];
    const { app, env, db, adminCookie } = await envFor({
      createMailProvisioner: () => ({
        createAccount: async ({ emailPrefix }) => ({ email: `${emailPrefix}@example.com` }),
        disableAccount: async () => undefined,
        enableAccount: async () => undefined,
        resetPassword: async () => undefined,
      }),
      createMailSender: () => ({
        send: async (message: MailMessage) => {
          sent.push(message);
        },
      }),
    });
    db.run(
      "INSERT INTO instance_config (key, value) VALUES ('mail', ?)",
      JSON.stringify(FULL_MAIL_CONFIG),
    );

    // 邀请 → 公开填表（带个人邮箱）→ 管理员批准（完整实例：开号 + 签激活令牌 + 发邮件）
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
    const inviteTokenHash = await hashOneTimeToken(inviteToken);

    const applied = await app.request(
      `https://team.example.com/api/invite/${inviteToken}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '新人',
          emailPrefix: 'newbie',
          personalEmail: 'new@personal.example',
        }),
      },
      env,
    );
    expect(applied.status).toBe(200);

    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${inviteTokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(approved.status).toBe(200);

    // 站内行：脱敏后只有收件人 + 「链接已生成」标记；整列不含 URL/激活路径/令牌明文
    const rows = db.query<{ payload: string; invited_email: string }>(
      "SELECT payload, invited_email FROM notifications WHERE type = 'account_ready'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invited_email).toBe('new@personal.example');
    expect(Object.keys(JSON.parse(rows[0]!.payload) as Record<string, unknown>).sort()).toEqual([
      'activateLinkGenerated',
      'email',
    ]);
    expect(rows[0]?.payload).not.toMatch(/https?:\/\/|\/activate\/|token/i);

    // 邮件正文没被脱敏误伤：链接是刚签发的那条真令牌（库里只有哈希、未用、未过期）
    const accountMail = sent.find((message) => message.subject.includes('账号已开通'));
    expect(accountMail?.to).toBe('new@personal.example');
    const linkToken = /\/activate\/(\S+)/.exec(accountMail?.text ?? '')?.[1];
    expect(linkToken).toBeTruthy();
    expect(
      db.first(
        'SELECT email, used_at FROM invite_activations WHERE token_hash = ?',
        await hashOneTimeToken(linkToken!),
      ),
    ).toEqual({ email: 'newbie@example.com', used_at: null });
  });
});

describe('#167 发信轴吃 mail.enabled（关闭即不装配 sender）', () => {
  it('enabled=false（字段齐全）：邀请→填表→批准→模块启停全链零发信，工厂零调用', async () => {
    const sent: Array<{ to: string; subject: string }> = [];
    const factory = vi.fn(() => ({
      send: async (message: MailMessage) => {
        sent.push({ to: message.to, subject: message.subject });
      },
    }));
    const { app, env, db, adminCookie } = await envFor({ createMailSender: factory });
    // 关 ≠ 删行：完整 SMTP 配置在场，只是 enabled:false（设置页开关关闭后的真实落库形状）。
    db.run(
      "INSERT INTO instance_config (key, value) VALUES ('mail', ?)",
      JSON.stringify({ ...FULL_MAIL_CONFIG, enabled: false }),
    );

    // 邀请 → 公开填表（弱化实例表单可省邮箱；带上个人邮箱走历史兼容路径）
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
    const token = inviteUrl.split('/invite/')[1]!;
    const tokenHash = await hashOneTimeToken(token);
    const applied = await app.request(
      `https://team.example.com/api/invite/${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '新人',
          emailPrefix: 'u_new',
          personalEmail: 'new@personal.example',
        }),
      },
      env,
    );
    expect(applied.status).toBe(200);

    // 批准：弱化实例批准即激活——不开户、不建激活行、不发激活邮件
    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${tokenHash}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ status: 'approved', email: null });

    // 同实例另一条发信接线：模块启停广播（module_toggled 渠道位只站内，装配口照样过开关）
    const toggled = await app.request(
      'https://team.example.com/api/admin/modules/hello/toggle',
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      },
      env,
    );
    expect(toggled.status).toBe(200);

    // 核心断言（#167）：整链没装配过发信口，一封都没尝试发
    expect(factory).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(db.query("SELECT id FROM audit_log WHERE action = 'notification_email_failed'")).toEqual(
      [],
    );

    // 站内轴不受影响：invite_pending（管理员）+ invite_result（悬挂个人邮箱）+ module_toggled×2
    expect(
      db
        .query<{ type: string }>('SELECT type FROM notifications ORDER BY rowid')
        .map((row) => row.type),
    ).toEqual(['invite_pending', 'invite_result', 'module_toggled', 'module_toggled']);
    // 弱化实例全链：零开户（无 account_ready）、零激活行
    expect(db.query("SELECT id FROM notifications WHERE type = 'account_ready'")).toEqual([]);
    expect(db.first<{ count: number }>('SELECT COUNT(*) AS count FROM invite_activations')).toEqual(
      { count: 0 },
    );
    expect(
      db.first<{ status: string }>('SELECT status FROM invites WHERE token_hash = ?', tokenHash),
    ).toEqual({ status: 'approved' });
  });
});
