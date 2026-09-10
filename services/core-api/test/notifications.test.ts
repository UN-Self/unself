// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 通知域行为测试（#19）：真 SQLite + 真迁移 + 真 D1 适配器（test-factory），
 * 发信口是外部边界，用 fake sender 观察收件人/主题与失败路径；HTTP 层自包含挂载路由。
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '@unself/mail-smtp';

import { generateInstanceKeyPair } from '../src/keys';
import { registerNotificationRoutes } from '../src/routes/notifications';
import { createSessionToken } from '../src/session';
import {
  bindPendingNotifications,
  configuredMailSender,
  deliverNotification,
} from '../src/services/notifications';
import { createCoreDb, type CoreTestDb } from './test-factory';
import type { Bindings } from '../src/index';

/** 真 users 表种一行（通知收件人解析依赖 email/status）。 */
function seedUser(db: CoreTestDb, id: string, email: string | null, status = 'active'): void {
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, email, status) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    'https://idp.example.com',
    `${id}-sub`,
    id,
    email,
    status,
  );
}

/** 真 notifications 表种一行（列表/已读断言用）。 */
function seedNotification(
  db: CoreTestDb,
  id: string,
  userId: string,
  type: string,
  payload: unknown,
  isRead = 0,
): void {
  db.run(
    'INSERT INTO notifications (id, user_id, invited_email, type, payload, is_read) VALUES (?, ?, NULL, ?, ?, ?)',
    id,
    userId,
    type,
    JSON.stringify(payload),
    isRead,
  );
}

describe('deliverNotification：类型分派与渠道位', () => {
  it('module_toggled（email=0）：只写站内一行，不触碰发信口', async () => {
    const db = createCoreDb();
    seedUser(db, 'u_1', 'u1@example.com');
    const send = vi.fn(async (_message: MailMessage) => {});

    const result = await deliverNotification(
      db.d1,
      { send },
      'module_toggled',
      { moduleId: 'hello', enabled: true },
      { userId: 'u_1' },
    );

    expect(result).toEqual({ inApp: 1, email: 'skipped' });
    expect(send).not.toHaveBeenCalled();
    const row = db.first<{ user_id: string; invited_email: string | null; type: string; payload: string }>(
      'SELECT user_id, invited_email, type, payload FROM notifications',
    );
    expect(row).toMatchObject({
      user_id: 'u_1',
      invited_email: null,
      type: 'module_toggled',
    });
    expect(JSON.parse(row?.payload ?? '')).toEqual({ moduleId: 'hello', enabled: true });
  });

  it('invite_result 悬挂收件人（email=1）：站内挂 invited_email，邮件发到邀请邮箱', async () => {
    const db = createCoreDb();
    const send = vi.fn(async (_message: MailMessage) => {});

    const result = await deliverNotification(
      db.d1,
      { send },
      'invite_result',
      { approved: true, name: '小林', approver: '管理' },
      { invitedEmail: 'invitee@example.com' },
    );

    expect(result).toEqual({ inApp: 1, email: 'sent' });
    expect(db.first('SELECT user_id, invited_email FROM notifications')).toEqual({
      user_id: null,
      invited_email: 'invitee@example.com',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'invitee@example.com',
        subject: expect.stringContaining('已通过'),
      }),
    );
  });

  it('account_ready 对已建档用户：站内 + 发到用户邮箱', async () => {
    const db = createCoreDb();
    seedUser(db, 'u_1', 'user@example.com');
    const send = vi.fn(async (_message: MailMessage) => {});

    const result = await deliverNotification(
      db.d1,
      { send },
      'account_ready',
      { email: 'user@example.com', activateUrl: 'https://team.example.com/activate?token=t' },
      { userId: 'u_1' },
    );

    expect(result).toEqual({ inApp: 1, email: 'sent' });
    expect(db.first('SELECT user_id FROM notifications')).toEqual({ user_id: 'u_1' });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: expect.stringContaining('账号已开通'),
      }),
    );
  });

  it('无发信口（弱化实例）：邮件静默降级 skipped，站内照写', async () => {
    const db = createCoreDb();

    const result = await deliverNotification(
      db.d1,
      null,
      'invite_result',
      { approved: false, name: '小林' },
      { invitedEmail: 'invitee@example.com' },
    );

    expect(result).toEqual({ inApp: 1, email: 'skipped' });
    expect(db.query('SELECT id FROM notifications')).toHaveLength(1);
  });

  it('发信失败：站内仍落库，失败落审计（含收件人/类型/人话原因）', async () => {
    const db = createCoreDb();
    const send = vi.fn(async (_message: MailMessage): Promise<void> => {
      throw new Error('SMTP 连接超时');
    });

    const result = await deliverNotification(
      db.d1,
      { send },
      'invite_result',
      { approved: true, name: '小林' },
      { invitedEmail: 'invitee@example.com' },
    );

    expect(result).toEqual({ inApp: 1, email: 'failed' });
    expect(db.query('SELECT id FROM notifications')).toHaveLength(1);
    const failures = db.query<{ actor: string; action: string; target: string }>(
      "SELECT actor, action, target FROM audit_log WHERE action = 'notification_email_failed'",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.actor).toBe('system');
    expect(failures[0]?.target).toContain('invitee@example.com');
    expect(failures[0]?.target).toContain('invite_result');
    expect(failures[0]?.target).toContain('SMTP 连接超时');
  });

  it('未登记的 type：不投递、不建行', async () => {
    const db = createCoreDb();
    const send = vi.fn(async (_message: MailMessage) => {});

    const result = await deliverNotification(
      db.d1,
      { send },
      'future_type',
      { anything: true },
      { invitedEmail: 'invitee@example.com' },
    );

    expect(result).toBeNull();
    expect(db.query('SELECT id FROM notifications')).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('broadcast：全体 active 各一行，disabled 不投', async () => {
    const db = createCoreDb();
    seedUser(db, 'u_a', 'a@example.com');
    seedUser(db, 'u_b', 'b@example.com');
    seedUser(db, 'u_disabled', 'c@example.com', 'disabled');

    const result = await deliverNotification(
      db.d1,
      null,
      'module_toggled',
      { moduleId: 'hello', enabled: false },
      { broadcast: true },
    );

    expect(result).toEqual({ inApp: 2, email: 'skipped' });
    expect(
      db.query<{ user_id: string }>('SELECT user_id FROM notifications ORDER BY user_id'),
    ).toEqual([{ user_id: 'u_a' }, { user_id: 'u_b' }]);
    expect(
      db.first('SELECT 1 AS hit FROM notifications WHERE user_id = ?', 'u_disabled'),
    ).toBeNull();
  });
});

describe('bindPendingNotifications：首登补投归属', () => {
  it('大小写不敏感地把悬挂通知绑定到新用户', async () => {
    const db = createCoreDb();
    seedUser(db, 'u_1', 'invitee@example.com');
    db.run(
      "INSERT INTO notifications (id, user_id, invited_email, type, payload) VALUES (?, NULL, ?, 'invite_result', ?)",
      'n1',
      'Invitee@Example.com',
      JSON.stringify({ approved: true }),
    );

    const changes = await bindPendingNotifications(db.d1, 'u_1', 'invitee@example.com');

    expect(changes).toBe(1);
    expect(db.first('SELECT user_id FROM notifications WHERE id = ?', 'n1')).toEqual({
      user_id: 'u_1',
    });
  });
});

describe('configuredMailSender：mail 段装配状态', () => {
  it('段缺失/非法 JSON → null；完整段 → 可用发信口；字段不全 → null', async () => {
    const db = createCoreDb();

    expect(await configuredMailSender(db.d1)).toBeNull();

    db.run("INSERT INTO instance_config (key, value) VALUES ('mail', ?)", '{ 不是 JSON');
    expect(await configuredMailSender(db.d1)).toBeNull();

    db.run(
      "UPDATE instance_config SET value = ? WHERE key = 'mail'",
      JSON.stringify({
        host: 'smtp.example.com',
        port: 465,
        username: 'bot',
        password: 'secret',
        from: 'noreply@example.com',
      }),
    );
    const sender = await configuredMailSender(db.d1);
    expect(sender?.send).toBeTypeOf('function');

    db.run(
      "UPDATE instance_config SET value = ? WHERE key = 'mail'",
      JSON.stringify({ host: 'smtp.example.com' }),
    );
    expect(await configuredMailSender(db.d1)).toBeNull();
  });
});

interface HttpTestEnv {
  app: Hono<{ Bindings: Bindings }>;
  db: CoreTestDb;
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string };
  cookieA: string;
  cookieB: string;
}

/** 自包含挂载通知路由 + 两个真实会话（不依赖组合根注册）。 */
async function httpEnv(): Promise<HttpTestEnv> {
  const pair = await generateInstanceKeyPair();
  const db = createCoreDb();
  seedUser(db, 'u_a', 'a@example.com');
  seedUser(db, 'u_b', 'b@example.com');
  const tokenA = await createSessionToken(
    { uid: 'u_a', iss: 'https://idp.example.com', sub: 'a-sub', name: 'A' },
    pair.privateKeyPem,
  );
  const tokenB = await createSessionToken(
    { uid: 'u_b', iss: 'https://idp.example.com', sub: 'b-sub', name: 'B' },
    pair.privateKeyPem,
  );
  const app = new Hono<{ Bindings: Bindings }>();
  registerNotificationRoutes(app);
  return {
    app,
    db,
    env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem },
    cookieA: `unself_session=${tokenA}`,
    cookieB: `unself_session=${tokenB}`,
  };
}

describe('通知 HTTP 读侧', () => {
  it('未登录：列表/未读数/已读全部 401', async () => {
    const { app, env } = await httpEnv();

    const list = await app.request('https://team.example.com/api/notifications', {}, env);
    expect(list.status).toBe(401);
    expect(await list.json()).toEqual({ error: 'authentication required' });

    const count = await app.request(
      'https://team.example.com/api/notifications/unread-count',
      {},
      env,
    );
    expect(count.status).toBe(401);

    const read = await app.request(
      'https://team.example.com/api/notifications/n1/read',
      { method: 'POST' },
      env,
    );
    expect(read.status).toBe(401);
  });

  it('列表只含自己的通知：倒序、typeLabel 中文、payload 已解析、isRead 布尔', async () => {
    const { app, db, env, cookieA } = await httpEnv();
    seedNotification(db, 'a1', 'u_a', 'module_toggled', { moduleId: 'hello', enabled: true }, 0);
    seedNotification(db, 'a2', 'u_a', 'account_ready', { email: 'a@example.com' }, 1);
    seedNotification(db, 'b1', 'u_b', 'module_toggled', { moduleId: 'hello', enabled: false }, 0);

    const res = await app.request(
      'https://team.example.com/api/notifications',
      { headers: { cookie: cookieA } },
      env,
    );

    expect(res.status).toBe(200);
    const items = (await res.json()) as Array<Record<string, unknown>>;
    expect(items.map((item) => item.id)).toEqual(['a2', 'a1']);
    expect(items[0]).toMatchObject({
      id: 'a2',
      type: 'account_ready',
      typeLabel: '账号已开通',
      payload: { email: 'a@example.com' },
      isRead: true,
    });
    expect(items[1]).toMatchObject({
      id: 'a1',
      type: 'module_toggled',
      typeLabel: '模块状态已更新',
      payload: { moduleId: 'hello', enabled: true },
      isRead: false,
    });
    expect(typeof items[1]?.isRead).toBe('boolean');
  });

  it('未读数只算自己的未读', async () => {
    const { app, db, env, cookieA } = await httpEnv();
    seedNotification(db, 'a1', 'u_a', 'module_toggled', {}, 0);
    seedNotification(db, 'a2', 'u_a', 'module_toggled', {}, 1);
    seedNotification(db, 'b1', 'u_b', 'module_toggled', {}, 0);

    const res = await app.request(
      'https://team.example.com/api/notifications/unread-count',
      { headers: { cookie: cookieA } },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 1 });
  });

  it('标记自己的未读：200 且真库置位、未读数减一、重复点幂等', async () => {
    const { app, db, env, cookieA } = await httpEnv();
    seedNotification(db, 'a1', 'u_a', 'module_toggled', {}, 0);
    seedNotification(db, 'a2', 'u_a', 'module_toggled', {}, 0);

    const res = await app.request(
      'https://team.example.com/api/notifications/a1/read',
      { method: 'POST', headers: { cookie: cookieA } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.first('SELECT is_read FROM notifications WHERE id = ?', 'a1')).toEqual({
      is_read: 1,
    });

    const count = await app.request(
      'https://team.example.com/api/notifications/unread-count',
      { headers: { cookie: cookieA } },
      env,
    );
    expect(await count.json()).toEqual({ count: 1 });

    const again = await app.request(
      'https://team.example.com/api/notifications/a1/read',
      { method: 'POST', headers: { cookie: cookieA } },
      env,
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
  });

  it('标记他人通知：404 且对方行保持未读', async () => {
    const { app, db, env, cookieA, cookieB } = await httpEnv();
    seedNotification(db, 'b1', 'u_b', 'module_toggled', {}, 0);

    const res = await app.request(
      'https://team.example.com/api/notifications/b1/read',
      { method: 'POST', headers: { cookie: cookieA } },
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'notification not found' });
    expect(db.first('SELECT is_read FROM notifications WHERE id = ?', 'b1')).toEqual({
      is_read: 0,
    });

    const owner = await app.request(
      'https://team.example.com/api/notifications/b1/read',
      { method: 'POST', headers: { cookie: cookieB } },
      env,
    );
    expect(owner.status).toBe(200);
  });
});
