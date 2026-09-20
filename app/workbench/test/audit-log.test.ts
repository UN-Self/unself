// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Bindings } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { requireAdmin } from '../src/middleware/admin';
import { AUDIT_LOG_LIMIT, registerAuditRoutes, type AuditLogEntry } from '../src/routes/audit';
import { createSessionToken } from '../src/session';
import { createCoreDb, type CoreTestDb } from './test-factory';

const AUDIT_URL = 'https://team.example.com/api/admin/audit-log';

/**
 * 独立挂载审计域与 admin 守卫（#17 的路由尚未接进组合根，等价于
 * `app.use('/api/admin/*', requireAdmin())` + `registerAuditRoutes(app)`）。
 */
function createAuditApp(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use('/api/admin/*', requireAdmin());
  registerAuditRoutes(app);
  return app;
}

interface AuditTestEnv {
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string };
  db: CoreTestDb;
  adminCookie: string;
  memberCookie: string;
}

/** 真 users 表 + admin/member 两个签名会话，守卫读到的是真库角色。 */
async function envFor(): Promise<AuditTestEnv> {
  const pair = await generateInstanceKeyPair();
  const db = createCoreDb();
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)',
    'u_admin',
    'https://idp.example.com',
    'admin-sub',
    '管理',
    'admin',
  );
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)',
    'u_member',
    'https://idp.example.com',
    'member-sub',
    '成员',
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

/** 直插真 audit_log（target 缺省即 NULL），绕开写路径只测只读端点的行为。 */
function seedAudit(
  db: CoreTestDb,
  rows: Array<{ actor: string; action: string; target?: string | null }>,
): void {
  for (const row of rows) {
    db.run(
      'INSERT INTO audit_log (actor, action, target) VALUES (?, ?, ?)',
      row.actor,
      row.action,
      row.target ?? null,
    );
  }
}

function getAudit(env: AuditTestEnv['env'], cookie?: string) {
  return createAuditApp().request(
    AUDIT_URL,
    cookie === undefined ? {} : { headers: { cookie } },
    env,
  );
}

describe('管理端审计列表（#17）', () => {
  it('管理员拿到新的在前的列表，字段形状固定且 target 可为 null', async () => {
    const { env, db, adminCookie } = await envFor();
    seedAudit(db, [
      { actor: 'u_admin', action: 'module_enabled', target: 'hello' },
      { actor: 'u_admin', action: 'member_disabled', target: 'u_member' },
      { actor: 'u_admin', action: 'setup_activated' },
    ]);

    const res = await getAudit(env, adminCookie);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as AuditLogEntry[];

    // 倒序：最后一次写入（id 最大）排最前。
    expect(entries.map((entry) => entry.action)).toEqual([
      'setup_activated',
      'member_disabled',
      'module_enabled',
    ]);
    // target 缺省的行返回 null，其余字段齐全。
    expect(entries[0]).toMatchObject({
      id: expect.any(Number),
      actor: 'u_admin',
      action: 'setup_activated',
      target: null,
      created_at: expect.any(String),
    });
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual([
      'action',
      'actor',
      'created_at',
      'id',
      'target',
    ]);
    expect(entries[1]).toMatchObject({ action: 'member_disabled', target: 'u_member' });
  });

  it('超过上限时只回最新 200 条', async () => {
    const { env, db, adminCookie } = await envFor();
    seedAudit(
      db,
      Array.from({ length: 205 }, (_, index) => ({
        actor: 'u_admin',
        action: `action_${index}`,
      })),
    );

    const res = await getAudit(env, adminCookie);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as AuditLogEntry[];

    expect(AUDIT_LOG_LIMIT).toBe(200);
    expect(entries).toHaveLength(200);
    expect(entries[0]?.action).toBe('action_204');
    expect(entries.at(-1)?.action).toBe('action_5');
    // 最新的 200 条 id 严格递减，最旧 5 条（action_0..4）被截断。
    expect(entries.some((entry) => entry.action === 'action_4')).toBe(false);
  });

  it('无会话 401、普通成员 403，且都不泄露审计内容', async () => {
    const { env, db, memberCookie } = await envFor();
    seedAudit(db, [{ actor: 'u_admin', action: 'module_enabled', target: 'hello' }]);

    const anonymous = await getAudit(env);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: 'authentication required' });

    const member = await getAudit(env, memberCookie);
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({ error: 'admin required' });
  });
});
