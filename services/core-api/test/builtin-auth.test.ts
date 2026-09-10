// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 内置身份全链集成（issue-A）：真 SQLite（迁移建表）+ 路由级 app.request。
 *
 * 覆盖 task-A §8：注册→批准→内置登录全链、唯一性双闸（软 409 + 硬闸恰好一成）、
 * 登录 401/404 同文案、setup builtin-admin、admin 重置密码、auth/methods、
 * OIDC 路径回归（既有测试零改动全绿）。故意改坏任一业务行为对应用例必红。
 */
import { describe, expect, it } from 'vitest';

import { createApp, type CoreApiDependencies } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { hashOneTimeToken } from '../src/one-time-token';
import { createSessionToken } from '../src/session';
import { createCoreDb, type CoreTestDb } from './test-factory';
const ISSUER = 'https://idp.example.com';

interface Env {
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string };
  db: CoreTestDb;
  adminCookie: string;
}

/** 真 users 表（一个 OIDC admin + 一个 OIDC member）+ 签名会话。 */
async function envFor(): Promise<Env> {
  const pair = await generateInstanceKeyPair();
  const db = createCoreDb();
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, email, role) VALUES (?, ?, ?, ?, ?, ?)',
    'u_admin',
    ISSUER,
    'admin-sub',
    '管理',
    'admin@example.com',
    'admin',
  );
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, email, role) VALUES (?, ?, ?, ?, ?, ?)',
    'u_oidc_member',
    ISSUER,
    'member-sub',
    'OIDC成员',
    'member@example.com',
    'user',
  );
  const adminCookie = `unself_session=${await createSessionToken(
    { uid: 'u_admin', iss: ISSUER, sub: 'admin-sub', name: '管理' },
    pair.privateKeyPem,
  )}`;
  return { env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem }, db, adminCookie };
}

type TestApp = ReturnType<typeof createApp>;

function appWith(deps: CoreApiDependencies = {}): TestApp {
  return createApp(deps);
}

/** 管理员生成邀请，返回明文 token。 */
async function createInviteVia(app: TestApp, env: Env['env'], adminCookie: string): Promise<string> {
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
  return inviteUrl.split('/invite/')[1]!;
}

/** 公开提交注册表单。 */
async function submit(app: TestApp, env: Env['env'], token: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    `https://team.example.com/api/invite/${token}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '新人', emailPrefix: 'u_new', personalEmail: 'new@personal.example', ...body }),
    },
    env,
  );
}

/** 内置登录（不跟随 redirect）。 */
async function login(app: TestApp, env: Env['env'], username: string, password: string): Promise<Response> {
  return app.request(
    'https://team.example.com/api/auth/login',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    },
    env,
  );
}

describe('内置身份（issue-A）', () => {
  it('注册→批准→内置登录全链：users/builtin_credentials 落行，invite approved，登录会话可用', async () => {
    const app = appWith();
    const { env, db, adminCookie } = await envFor();
    const token = await createInviteVia(app, env, adminCookie);

    const submitted = await submit(app, env, token, { username: 'alice', password: 'password123' });
    expect(submitted.status).toBe(200);

    // 批准前：users 无内置行
    expect(db.first("SELECT COUNT(*) AS c FROM users WHERE issuer = 'builtin'")?.c).toBe(0);

    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${await hashOneTimeToken(token)}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ status: 'approved', email: null });

    // 库内真行：users 内置 + 凭证 + invite 状态
    const user = db.first<{ id: string; issuer: string; role: string; status: string; personal_email: string }>(
      "SELECT id, issuer, role, status, personal_email FROM users WHERE display_name = '新人'",
    );
    expect(user).toMatchObject({ issuer: 'builtin', role: 'member', status: 'active', personal_email: 'new@personal.example' });
    expect(
      db.first('SELECT username FROM builtin_credentials WHERE user_id = ?', user!.id),
    ).toEqual({ username: 'alice' });
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', await hashOneTimeToken(token))).toEqual({
      status: 'approved',
    });

    // 登录 → Cookie → /api/me
    const res = await login(app, env, 'alice', 'password123');
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('unself_session=');
    const cookie = setCookie.split(';')[0]!;
    const me = await app.request('https://team.example.com/api/me', { headers: { cookie } }, env);
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { authenticated: boolean; user?: { role: string; name: string } };
    expect(meBody.authenticated).toBe(true);
    expect(meBody.user).toMatchObject({ role: 'member', name: '新人' });

    // 登出端点行为：清 Cookie（服务端无状态会话，登出 = Set-Cookie 过期）
    const logoutRes = await app.request('https://team.example.com/api/auth/logout', { method: 'POST', headers: { cookie } }, env);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.get('set-cookie') ?? '').toContain('unself_session=;');
    // 无效/篡改 Cookie → /api/me 401（会话有效性由服务端验签把守，前端只是视图）
    const after = await app.request('https://team.example.com/api/me', { headers: { cookie: 'unself_session=tampered' } }, env);
    expect(after.status).toBe(401);
  });

  it('唯一性软闸：users 与 invites 双表查重，重名（含大小写变体）注册即 409', async () => {
    const app = appWith();
    const { env, db, adminCookie } = await envFor();

    // 撞已有内置用户（envFor 未建内置用户 → 先走全链建一个 carol）
    const t1 = await createInviteVia(app, env, adminCookie);
    expect((await submit(app, env, t1, { username: 'carol', password: 'password123' })).status).toBe(200);
    expect(
      (
        await app.request(
          `https://team.example.com/api/admin/invites/${await hashOneTimeToken(t1)}/approve`,
          { method: 'POST', headers: { cookie: adminCookie } },
          env,
        )
      ).status,
    ).toBe(200);

    // 第二个链接用 carol / CAROL 变体 → 409，链接仍 pending 可改后重提
    const t2 = await createInviteVia(app, env, adminCookie);
    const clashUser = await submit(app, env, t2, { username: 'carol', password: 'password123' });
    expect(clashUser.status).toBe(409);
    expect(await clashUser.json()).toEqual({ error: '用户名已被占用' });
    const clashCase = await submit(app, env, t2, { username: 'CAROL', password: 'password123' });
    expect(clashCase.status).toBe(409);

    // 纯 invites 撞 invites（users 无行）：pending 申请占名后另一个链接同名 409
    const t3 = await createInviteVia(app, env, adminCookie);
    expect((await submit(app, env, t3, { username: 'dave', password: 'password123' })).status).toBe(200);
    const t4 = await createInviteVia(app, env, adminCookie);
    const clashInvite = await submit(app, env, t4, { username: 'Dave', password: 'password123' });
    expect(clashInvite.status).toBe(409);
    expect(db.first<{ c: number }>('SELECT COUNT(*) AS c FROM users WHERE issuer = ?', 'builtin')?.c).toBe(1);
  });

  it('唯一性硬闸：两条 pending 申请同名，依次批准恰好一成、另一 409 且 invite 留 pending', async () => {
    const app = appWith();
    const { env, db, adminCookie } = await envFor();

    // 两条链接先后提交同名 erin（软闸只查 pending/approved 的 invite_credentials——
    // 第二条提交时第一条仍 pending，故软闸会拦；这里直接在库内制造「软闸失效窗口」：
    // 把第一条的 username 抹掉再提交第二条，模拟并发窗口下的双 pending 同名。
    const t1 = await createInviteVia(app, env, adminCookie);
    expect((await submit(app, env, t1, { username: 'erin', password: 'password123' })).status).toBe(200);
    const t2 = await createInviteVia(app, env, adminCookie);
    // 绕开软闸：模拟 TOCTOU 窗口（第一条被改为无主，第二条用同名提交成功落库）
    db.run('UPDATE invite_credentials SET username = ? WHERE username = ?', 'erin__moved', 'erin');
    expect((await submit(app, env, t2, { username: 'erin', password: 'password123' })).status).toBe(200);
    db.run('UPDATE invite_credentials SET username = ? WHERE username = ?', 'erin', 'erin__moved');

    const h1 = await hashOneTimeToken(t1);
    const h2 = await hashOneTimeToken(t2);

    const first = await app.request(
      `https://team.example.com/api/admin/invites/${h1}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      `https://team.example.com/api/admin/invites/${h2}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string; detail: string };
    expect(body.detail).toContain('已被占用');
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', h2)).toEqual({ status: 'pending' });

    // 恰好一个内置用户落库
    expect(
      db.first<{ c: number }>("SELECT COUNT(*) AS c FROM builtin_credentials WHERE username = 'erin'")?.c,
    ).toBe(1);
  });

  it('登录失败统一文案：错密码 401 与错用户名 404 响应体逐字相同', async () => {
    const app = appWith();
    const { env, adminCookie } = await envFor();
    const token = await createInviteVia(app, env, adminCookie);
    await submit(app, env, token, { username: 'frank', password: 'password123' });
    await app.request(
      `https://team.example.com/api/admin/invites/${await hashOneTimeToken(token)}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );

    const wrongPassword = await login(app, env, 'frank', 'wrong-password');
    expect(wrongPassword.status).toBe(401);
    const noUser = await login(app, env, 'nobody', 'wrong-password');
    expect(noUser.status).toBe(404);
    const wrongBody = JSON.stringify(await wrongPassword.json());
    const nobodyBody = JSON.stringify(await noUser.json());
    expect(wrongBody).toBe(nobodyBody);
    expect(wrongBody).toBe(JSON.stringify({ error: '用户名或密码错误' }));

    // 格式非法（密码 < 8）同文案 400，不暴露是格式错
    const badFormat = await login(app, env, 'frank', 'short');
    expect(badFormat.status).toBe(400);
    expect(JSON.stringify(await badFormat.json())).toBe(JSON.stringify({ error: '用户名或密码错误' }));
  });

  it('setup builtin-admin：建 admin + setup_done + 审计；封箱后二次被拒；账号可登录', async () => {
    const app = appWith();
    const { env, db } = await envFor();

    const res = await app.request(
      'https://team.example.com/api/setup/builtin-admin',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'boss', password: 'password123' }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; user: { role: string; name: string } };
    expect(body.ok).toBe(true);
    expect(body.user).toMatchObject({ role: 'admin', name: 'boss' });

    expect(
      db.first<{ role: string; status: string; issuer: string }>(
        'SELECT role, status, issuer FROM users WHERE display_name = ?',
        'boss',
      ),
    ).toEqual({ role: 'admin', status: 'active', issuer: 'builtin' });
    expect(db.first("SELECT value FROM instance_config WHERE key = 'setup_done'")).toEqual({ value: '1' });
    expect(db.first<{ c: number }>("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'builtin_admin_created'")?.c).toBe(1);

    // 封箱：二次调用（无论用户名）一律 409
    const again = await app.request(
      'https://team.example.com/api/setup/builtin-admin',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'other', password: 'password123' }),
      },
      env,
    );
    expect(again.status).toBe(409);

    // 该账号可登录
    expect((await login(app, env, 'boss', 'password123')).status).toBe(200);
  });

  it('admin 重置密码：旧密码失效新密码可登；OIDC 用户 409「该成员无内置登录」', async () => {
    const app = appWith();
    const { env, db, adminCookie } = await envFor();
    const token = await createInviteVia(app, env, adminCookie);
    await submit(app, env, token, { username: 'grace', password: 'password123' });
    await app.request(
      `https://team.example.com/api/admin/invites/${await hashOneTimeToken(token)}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    const user = db.first<{ id: string }>("SELECT id FROM users WHERE display_name = '新人'");

    const reset = await app.request(
      `https://team.example.com/api/admin/members/${user!.id}/reset-password`,
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'new-password-9' }),
      },
      env,
    );
    expect(reset.status).toBe(200);
    expect(db.first<{ c: number }>("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'member_password_reset'")?.c).toBe(1);

    expect((await login(app, env, 'grace', 'password123')).status).toBe(401);
    expect((await login(app, env, 'grace', 'new-password-9')).status).toBe(200);

    // OIDC 用户（无 builtin_credentials 行）→ 409 人话
    const oidc = await app.request(
      'https://team.example.com/api/admin/members/u_oidc_member/reset-password',
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'new-password-9' }),
      },
      env,
    );
    expect(oidc.status).toBe(409);
    expect(await oidc.json()).toEqual({ error: '该成员无内置登录' });

    // 不存在的成员 → 404
    const missing = await app.request(
      'https://team.example.com/api/admin/members/u_missing/reset-password',
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'new-password-9' }),
      },
      env,
    );
    expect(missing.status).toBe(404);
  });

  it('auth/methods：未配 OIDC 回 {builtin:true,oidc:false}；配了 oidc_issuer 即 true', async () => {
    const app = appWith();
    const { env, db } = await envFor();

    const before = await app.request('https://team.example.com/api/auth/methods', {}, env);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ builtin: true, oidc: false });

    db.run("INSERT INTO instance_config (key, value) VALUES ('oidc_issuer', 'https://idp.example.com')");
    const after = await app.request('https://team.example.com/api/auth/methods', {}, env);
    expect(await after.json()).toEqual({ builtin: true, oidc: true });
  });

  it('无内置注册的邀请：批准后不建内置用户（OIDC JIT 路径不受影响）', async () => {
    const app = appWith();
    const { env, db, adminCookie } = await envFor();
    const token = await createInviteVia(app, env, adminCookie);
    expect((await submit(app, env, token, {})).status).toBe(200);

    const approved = await app.request(
      `https://team.example.com/api/admin/invites/${await hashOneTimeToken(token)}/approve`,
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ status: 'approved', email: null });
    expect(db.first<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE issuer = 'builtin'")?.c).toBe(0);
    expect(db.first<{ c: number }>('SELECT COUNT(*) AS c FROM invite_credentials')?.c).toBe(0);
  });
});
