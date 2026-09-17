// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 会话守卫行为测试（issue #187，S7 停用即时生效）。
 *
 * 口径：
 * - **路由级集成**为主：`createApp()` 全装配（证明挂载范围与 `index.ts` 的真实组合一致）、
 *   真 SQLite + 真迁移 + 真 D1 适配器（test-factory），会话是可验签的真 Cookie；
 * - 停用/删除走真库真行（直插/真管理端点），不手搓假守卫；
 * - 公开端点用例证明挂载范围没扩大（邀请填表/激活/健康/JWKS/登录探测仍匿名可用）。
 *
 * 语义矩阵（验收 2）：无会话 401 / 成员已停用或已删除 403 / 非管理员 403。
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import type { Bindings } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { requireAdmin } from '../src/middleware/admin';
import { requireActiveMember, type SessionGuardVariables } from '../src/middleware/session-guard';
import { hashOneTimeToken } from '../src/one-time-token';
import { createSessionToken, verifySessionToken } from '../src/session';
import { createCoreDb, type CoreTestDb } from './test-factory';

const ORIGIN = 'https://team.example.com';

const helloManifest = {
  id: 'hello',
  route: '/m/hello',
  entry: 'https://team.example.com/m/hello/',
  runtimes: ['worker'],
  version: '1.0.0',
};

interface GuardTestEnv {
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string };
  db: CoreTestDb;
  adminCookie: string;
  memberCookie: string;
}

/** 真 users 表两个成员（admin/member）+ 两个可验签会话；权限真值始终在同一 SQLite 库。 */
async function envFor(): Promise<GuardTestEnv> {
  const pair = await generateInstanceKeyPair();
  const db = createCoreDb();
  db.run(
    "INSERT INTO users (id, issuer, sub, display_name, email, role) VALUES ('u_admin', 'https://idp', 'admin-sub', '管理', 'admin@example.com', 'admin')",
  );
  db.run(
    "INSERT INTO users (id, issuer, sub, display_name, email, role) VALUES ('u_member', 'https://idp', 'member-sub', '成员', 'member@example.com', 'user')",
  );
  const adminCookie = `unself_session=${await createSessionToken(
    { uid: 'u_admin', iss: 'https://idp', sub: 'admin-sub', name: '管理' },
    pair.privateKeyPem,
  )}`;
  const memberCookie = `unself_session=${await createSessionToken(
    { uid: 'u_member', iss: 'https://idp', sub: 'member-sub', name: '成员' },
    pair.privateKeyPem,
  )}`;
  return {
    env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem },
    db,
    adminCookie,
    memberCookie,
  };
}

function seedHello(db: CoreTestDb): void {
  db.run(
    'INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES (?, 1, ?, ?)',
    'hello',
    helloManifest.version,
    JSON.stringify(helloManifest),
  );
}

function seedNotification(db: CoreTestDb, id: string, userId: string, isRead = 0): void {
  db.run(
    "INSERT INTO notifications (id, user_id, invited_email, type, payload, is_read) VALUES (?, ?, NULL, 'module_toggled', '{\"moduleId\":\"hello\",\"enabled\":true}', ?)",
    id,
    userId,
    isRead,
  );
}

/** 受保护端点（成员级）：方法 + 路径，请求均为匿名/带 Cookie 两态共用。 */
const MEMBER_PROTECTED: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/me' },
  { method: 'GET', path: '/api/notifications' },
  { method: 'GET', path: '/api/notifications/unread-count' },
  { method: 'POST', path: '/api/notifications/n_1/read' },
  { method: 'POST', path: '/api/modules/hello/token' },
];

/** 管理员端点（非 admin 一律 403；无会话 401）。 */
const ADMIN_PROTECTED: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/admin/members' },
  { method: 'GET', path: '/api/admin/modules' },
  { method: 'GET', path: '/api/admin/audit-log' },
];

async function call(
  app: ReturnType<typeof createApp>,
  env: GuardTestEnv['env'],
  method: string,
  path: string,
  cookie?: string,
): Promise<Response> {
  return app.request(`${ORIGIN}${path}`, { method, headers: cookie ? { cookie } : {} }, env);
}

describe('停用即时生效（验收 1）：既有会话下一次受保护请求即 403', () => {
  it('停用后成员域全部 403（含通知读侧）；启用后同一 Cookie 立即恢复', async () => {
    const app = createApp();
    const { env, db, adminCookie, memberCookie } = await envFor();
    seedHello(db);
    seedNotification(db, 'n_1', 'u_member');

    // 基线：停用前这些端点对该成员的会话是通的（下面 403 不是路径本身写错）
    for (const { method, path } of MEMBER_PROTECTED) {
      expect([method, path, (await call(app, env, method, path, memberCookie)).status]).toEqual([
        method,
        path,
        200,
      ]);
    }

    // 真管理端点停用（不直插状态：走 #49 的生命周期，与生产同一条路径）
    const disabled = await app.request(`${ORIGIN}/api/admin/members/u_member/disable`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    }, env);
    expect(disabled.status).toBe(200);
    expect(db.first<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u_member')).toEqual({
      status: 'disabled',
    });

    // 会话 Cookie 本身仍然可验签、未过期：403 来自守卫的现行 status 判定，不是 TTL 到期
    const rawCookie = memberCookie.replace('unself_session=', '');
    expect(await verifySessionToken(rawCookie, env.JWT_PRIVATE_KEY)).not.toBeNull();

    for (const { method, path } of MEMBER_PROTECTED) {
      const res = await call(app, env, method, path, memberCookie);
      expect([method, path, res.status]).toEqual([method, path, 403]);
      expect(await res.json()).toEqual({ error: 'account disabled' });
    }

    // 重新启用：同一 Cookie 下一个请求立刻恢复（无缓存、无广播延迟）
    const enabled = await app.request(`${ORIGIN}/api/admin/members/u_member/enable`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    }, env);
    expect(enabled.status).toBe(200);
    expect((await call(app, env, 'GET', '/api/me', memberCookie)).status).toBe(200);
    expect((await call(app, env, 'GET', '/api/notifications', memberCookie)).status).toBe(200);
  });

  it('停用的管理员会话同样即刻失去管理域（停用判定先于角色判定）', async () => {
    const app = createApp();
    const { env, db, adminCookie } = await envFor();
    db.run(
      "INSERT INTO users (id, issuer, sub, display_name, role) VALUES ('u_admin2', 'https://idp', 'admin2-sub', '管理二', 'admin')",
    );
    const admin2Cookie = `unself_session=${await createSessionToken(
      { uid: 'u_admin2', iss: 'https://idp', sub: 'admin2-sub', name: '管理二' },
      env.JWT_PRIVATE_KEY,
    )}`;
    expect((await call(app, env, 'GET', '/api/admin/members', admin2Cookie)).status).toBe(200);

    await app.request(`${ORIGIN}/api/admin/members/u_admin2/disable`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    }, env);

    const res = await call(app, env, 'GET', '/api/admin/members', admin2Cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account disabled' });
  });
});

describe('语义矩阵（验收 2）', () => {
  it('未登录：受保护端点一律 401（成员域、管理域、setup 提权）', async () => {
    const app = createApp();
    const { env, db } = await envFor();
    seedHello(db);
    seedNotification(db, 'n_1', 'u_member');

    for (const { method, path } of [...MEMBER_PROTECTED, ...ADMIN_PROTECTED]) {
      const res = await call(app, env, method, path);
      expect([method, path, res.status]).toEqual([method, path, 401]);
      expect(await res.json()).toEqual({ error: 'authentication required' });
    }
    // setup 提权：未登录先 401（不消费一次性 token 的判断留给有会话的请求）
    expect((await call(app, env, 'POST', '/api/setup/activate?token=whatever')).status).toBe(401);
  });

  it('非管理员：成员域 200、管理域一律 403（admin required）', async () => {
    const app = createApp();
    const { env, db, memberCookie } = await envFor();
    seedHello(db);
    seedNotification(db, 'n_1', 'u_member');

    expect((await call(app, env, 'GET', '/api/me', memberCookie)).status).toBe(200);
    for (const { method, path } of ADMIN_PROTECTED) {
      const res = await call(app, env, method, path, memberCookie);
      expect([method, path, res.status]).toEqual([method, path, 403]);
      expect(await res.json()).toEqual({ error: 'admin required' });
    }
  });

  it('已删除成员：会话签名仍有效，受保护端点一律 403（与停用同答，不区分存在性）', async () => {
    const app = createApp();
    const { env, db, memberCookie } = await envFor();
    seedHello(db);
    seedNotification(db, 'n_1', 'u_member');
    expect((await call(app, env, 'GET', '/api/me', memberCookie)).status).toBe(200);

    db.run('DELETE FROM users WHERE id = ?', 'u_member');
    expect(
      await verifySessionToken(memberCookie.replace('unself_session=', ''), env.JWT_PRIVATE_KEY),
    ).not.toBeNull();

    for (const { method, path } of MEMBER_PROTECTED) {
      const res = await call(app, env, method, path, memberCookie);
      expect([method, path, res.status]).toEqual([method, path, 403]);
      expect(await res.json()).toEqual({ error: 'account disabled' });
    }
  });

  it('无效/篡改会话 Cookie：按未登录 401（验签先于查库）', async () => {
    const app = createApp();
    const { env } = await envFor();
    const res = await call(app, env, 'GET', '/api/me', 'unself_session=tampered');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'authentication required' });
  });
});

describe('公开端点不受影响（验收 3）：挂载范围没有扩大', () => {
  it('邀请填表 / 激活 / 健康 / JWKS / 登录探测 / setup 状态：匿名一律可用', async () => {
    const app = createApp();
    const { env, db } = await envFor();
    const inviteToken = 'public-invite-token';
    db.run(
      "INSERT INTO invites (token_hash, status, personal_email, email_prefix, display_name, expires_at) VALUES (?, 'pending', 'a@b.test', 'a', 'A', datetime('now', '+1 day'))",
      await hashOneTimeToken(inviteToken),
    );
    const activateToken = 'public-activate-token';
    db.run(
      "INSERT INTO invite_activations (token_hash, invite_token_hash, email, expires_at) VALUES (?, 'ih', 'work@example.com', datetime('now', '+1 day'))",
      await hashOneTimeToken(activateToken),
    );

    const cases: ReadonlyArray<{ method: string; path: string; init?: RequestInit; expect: number }> = [
      { method: 'GET', path: '/api/health', expect: 200 },
      { method: 'GET', path: '/.well-known/jwks.json', expect: 200 },
      { method: 'GET', path: '/api/auth/methods', expect: 200 },
      { method: 'GET', path: '/api/auth/salt?username=someone', expect: 200 },
      { method: 'GET', path: '/api/setup/status', expect: 200 },
      { method: 'GET', path: `/api/invite/${inviteToken}`, expect: 200 },
      { method: 'GET', path: `/api/invite/${inviteToken}/status`, expect: 200 },
      { method: 'GET', path: `/api/activate/${activateToken}`, expect: 200 },
      // 成员侧模块清单：既有公开读口径（registry.test.ts 断言匿名 200），本轴不动
      { method: 'GET', path: '/api/modules', expect: 200 },
      // 匿名可调的 OIDC 探测：body 缺 issuer 回 400（不是守卫的 401）
      {
        method: 'POST',
        path: '/api/oidc/test-connection',
        init: { headers: { 'content-type': 'application/json' }, body: '{}' },
        expect: 400,
      },
    ];
    for (const { method, path, init, expect: want } of cases) {
      const res = await app.request(`${ORIGIN}${path}`, { method, ...init }, env);
      expect([method, path, res.status]).toEqual([method, path, want]);
    }

    // 公开填表提交（弱化实例：只需显示名）也照常走通
    const submitted = await app.request(
      `${ORIGIN}/api/invite/${inviteToken}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: '申请人' }),
      },
      env,
    );
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual({ ok: true });
  });

  it('停用成员带 Cookie 访问公开端点：不被守卫拦（公开口径与会话无关）', async () => {
    const app = createApp();
    const { env, db, adminCookie, memberCookie } = await envFor();
    db.run("UPDATE users SET status = 'disabled' WHERE id = 'u_member'");

    expect((await call(app, env, 'GET', '/api/health', memberCookie)).status).toBe(200);
    expect((await call(app, env, 'GET', '/api/auth/methods', memberCookie)).status).toBe(200);
    expect((await call(app, env, 'GET', '/api/modules', memberCookie)).status).toBe(200);
    expect((await call(app, env, 'GET', '/api/invite/ghost', memberCookie)).status).toBe(404);
    // 对照：同一个人同一 Cookie 的受保护端点仍被守卫拒（证明 403 来自挂载点，不是全局行为）
    expect((await call(app, env, 'GET', '/api/me', memberCookie)).status).toBe(403);
    expect((await call(app, env, 'GET', '/api/admin/members', adminCookie)).status).toBe(200);
  });
});

describe('中间件单测：requireActiveMember', () => {
  /** 最小挂载：探针回读守卫写入上下文的会话与成员真值。 */
  function probeApp() {
    const app = new Hono<{ Bindings: Bindings; Variables: SessionGuardVariables }>();
    app.use('/probe', requireActiveMember());
    app.get('/probe', (c) =>
      c.json({ uid: c.get('session').uid, role: c.get('member').role }),
    );
    return app;
  }

  it('无会话 401、active 放行并写入上下文、停用/删除 403、非管理员角色原样透传', async () => {
    const app = probeApp();
    const { env, db, memberCookie, adminCookie } = await envFor();

    expect((await app.request(`${ORIGIN}/probe`, {}, env)).status).toBe(401);
    expect(await (await app.request(`${ORIGIN}/probe`, { headers: { cookie: memberCookie } }, env)).json()).toEqual({
      uid: 'u_member',
      role: 'user',
    });
    expect(await (await app.request(`${ORIGIN}/probe`, { headers: { cookie: adminCookie } }, env)).json()).toEqual({
      uid: 'u_admin',
      role: 'admin',
    });

    db.run("UPDATE users SET status = 'disabled' WHERE id = 'u_member'");
    expect((await app.request(`${ORIGIN}/probe`, { headers: { cookie: memberCookie } }, env)).status).toBe(403);

    db.run('DELETE FROM users WHERE id = ?', 'u_admin');
    expect((await app.request(`${ORIGIN}/probe`, { headers: { cookie: adminCookie } }, env)).status).toBe(403);
  });
});

describe('中间件单测：requireAdmin 独立挂载（不走组合根前缀）仍走同一真值点', () => {
  it('无会话 401 / 非 admin 403 / 停用 admin 403 / active admin 放行', async () => {
    const app = new Hono<{ Bindings: Bindings }>();
    app.use('/admin-probe', requireAdmin());
    app.get('/admin-probe', (c) => c.json({ ok: true }));

    const { env, db, memberCookie, adminCookie } = await envFor();
    expect((await app.request(`${ORIGIN}/admin-probe`, {}, env)).status).toBe(401);
    expect((await app.request(`${ORIGIN}/admin-probe`, { headers: { cookie: memberCookie } }, env)).status).toBe(403);
    expect((await app.request(`${ORIGIN}/admin-probe`, { headers: { cookie: adminCookie } }, env)).status).toBe(200);

    db.run("UPDATE users SET status = 'disabled' WHERE id = 'u_admin'");
    expect((await app.request(`${ORIGIN}/admin-probe`, { headers: { cookie: adminCookie } }, env)).status).toBe(403);
  });
});
