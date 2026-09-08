// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import app from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { createCoreDb, type CoreTestDb } from './test-factory';

/** SQLite `datetime('now')` 落库文本语义（UTC，无 T/Z，非 ISO）。 */
const DATETIME_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 造带 u_1 会话 Cookie 的环境；u_1 落真 users 表（迁移 0001：issuer/sub NOT NULL 都要给）。 */
async function envFor(): Promise<{
  env: { JWT_PRIVATE_KEY: string; CORE_DB: D1Database };
  db: CoreTestDb;
  cookie: string;
}> {
  const pair = await generateInstanceKeyPair();
  const { createSessionToken } = await import('../src/session');
  const token = await createSessionToken(
    { uid: 'u_1', iss: 'https://idp', sub: 'u-1', name: '黄一' },
    pair.privateKeyPem,
  );
  const db = createCoreDb();
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)',
    'u_1',
    'https://idp',
    'u-1',
    '黄一',
    'user',
  );
  return {
    env: { JWT_PRIVATE_KEY: pair.privateKeyPem, CORE_DB: db.d1 },
    db,
    cookie: `unself_session=${token}`,
  };
}

/** 翻转 setup_done（真 SQL UPSERT；与 markSetupDone 语义一致，测试自种不走路由）。 */
function markSetupDone(db: CoreTestDb): void {
  db.run(
    "INSERT INTO instance_config (key, value) VALUES ('setup_done','1') ON CONFLICT(key) DO UPDATE SET value='1'",
  );
}

describe('setup 流程（一次性 token + 首个管理员）', () => {
  it('部署脚本生成 setup token：未激活时成功，已激活后 409 拒绝', async () => {
    const { env, db } = await envFor();
    const res = await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; setupUrl: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.setupUrl).toBe(`/setup?token=${body.token}`);

    // 真库：token 已落 setup_tokens 且未使用
    expect(
      db.first<{ used_at: string | null }>('SELECT used_at FROM setup_tokens WHERE token = ?', body.token),
    ).toEqual({ used_at: null });
    // 真库：审计留痕
    expect(db.query<{ action: string }>('SELECT action FROM audit_log').map((a) => a.action)).toContain(
      'setup_token_issued',
    );

    // 真 SQL 置位 setup_done（模拟已激活）
    markSetupDone(db);
    const again = await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env);
    expect(again.status).toBe(409);
  });

  it('status：未激活 + 无 token → tokenValid:false；激活后 done:true', async () => {
    const { env, db } = await envFor();
    const none = await app.request('https://team.example.com/api/setup/status', {}, env);
    expect(await none.json()).toEqual({ done: false, tokenValid: false });

    const gen = (await (
      await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env)
    ).json()) as { token: string };
    const withToken = await app.request(
      `https://team.example.com/api/setup/status?token=${gen.token}`,
      {},
      env,
    );
    expect(await withToken.json()).toEqual({ done: false, tokenValid: true });

    markSetupDone(db);
    const done = await app.request('https://team.example.com/api/setup/status', {}, env);
    expect(await done.json()).toEqual({ done: true });
  });

  it('激活全链路：校验 token + 会话 → 首个管理员诞生 → setup 封死', async () => {
    const { env, db, cookie } = await envFor();

    // 1) 生成 token
    const gen = (await (
      await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env)
    ).json()) as { token: string };

    // 2) 未登录激活 → 401 + loginUrl（#10 前端整页跳转用；断言 searchParams 语义）
    const anon = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      { method: 'POST' },
      env,
    );
    expect(anon.status).toBe(401);
    const anonBody = (await anon.json()) as { loginUrl: string };
    const loginUrl = new URL(anonBody.loginUrl);
    expect(`${loginUrl.origin}${loginUrl.pathname}`).toBe('https://team.example.com/api/auth/login');
    expect(loginUrl.searchParams.get('next')).toBe(`/setup?token=${gen.token}`);

    // 3) 会话 + token → 激活成功，用户升 admin
    const ok = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { ok: boolean; user: { role: string } };
    expect(okBody.ok).toBe(true);
    expect(okBody.user.role).toBe('admin');
    // 真库断言：users.role 已升 admin
    expect(db.first<{ role: string }>('SELECT role FROM users WHERE id = ?', 'u_1')).toEqual({ role: 'admin' });
    // 真库断言：setup_done 已置位
    expect(
      db.first<{ value: string }>("SELECT value FROM instance_config WHERE key = 'setup_done'"),
    ).toEqual({ value: '1' });
    // 真库断言：token 已消费，used_at 是 SQLite datetime 文本（非 ISO 带 T/Z）
    const tokenRow = db.first<{ created_at: string; used_at: string | null }>(
      'SELECT created_at, used_at FROM setup_tokens WHERE token = ?',
      gen.token,
    );
    expect(tokenRow).not.toBeNull();
    expect(tokenRow!.created_at).toMatch(DATETIME_TEXT);
    expect(tokenRow!.used_at).toMatch(DATETIME_TEXT);

    // 4) 同一 token 第二次使用被拒（验收：同一链接第二次使用被拒）
    const replay = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    // 已封死优先：先判 setup_done
    expect(replay.status).toBe(409);

    // 5) 激活后再发 token 也被拒
    const newToken = await app.request(
      'https://team.example.com/api/admin/setup-token',
      { method: 'POST' },
      env,
    );
    expect(newToken.status).toBe(409);

    // 6) 审计留痕（真 audit_log 表 action 列）
    const actions = db.query<{ action: string }>('SELECT action FROM audit_log').map((a) => a.action);
    expect(actions).toContain('setup_token_issued');
    expect(actions).toContain('setup_activated');
  });

  it('无效/伪造 token 激活被拒', async () => {
    const { env, db, cookie } = await envFor();
    const res = await app.request(
      'https://team.example.com/api/setup/activate?token=forged-token',
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(res.status).toBe(403);
    expect(db.first<{ role: string }>('SELECT role FROM users WHERE id = ?', 'u_1')).toEqual({ role: 'user' }); // 未提权
  });

  it('缺 token 回 400', async () => {
    const { env, cookie } = await envFor();
    const res = await app.request(
      'https://team.example.com/api/setup/activate',
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('激活持久化向导录入的 OIDC 字段（instance_config + 审计），登录走表优先', async () => {
    const { env, db, cookie } = await envFor();

    const gen = (await (
      await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env)
    ).json()) as { token: string };

    const oidc = {
      issuer: 'https://idp.example.com',
      clientId: 'app-1',
      clientSecret: 's3cret',
      scope: 'openid profile email',
    };
    const ok = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(oidc),
      },
      env,
    );
    expect(ok.status).toBe(200);

    // 真库断言：与 getOidcConfig 读取键一致的 oidc_* 四键
    const configValue = (key: string) =>
      db.first<{ value: string }>('SELECT value FROM instance_config WHERE key = ?', key)?.value ?? null;
    expect(configValue('oidc_issuer')).toBe(oidc.issuer);
    expect(configValue('oidc_client_id')).toBe(oidc.clientId);
    expect(configValue('oidc_client_secret')).toBe(oidc.clientSecret);
    expect(configValue('oidc_scope')).toBe(oidc.scope);

    // 审计（真 audit_log 表）
    expect(db.query<{ action: string }>('SELECT action FROM audit_log').map((a) => a.action)).toContain(
      'oidc_config_stored',
    );

    // 表优先：env 无 OIDC_* 时 login 仍按 instance_config 配置走 → 302（发现文档来自表里 issuer）
    const restore = installFakeDiscovery('https://idp.example.com');
    try {
      const login = await app.request('https://team.example.com/api/auth/login', {}, env);
      expect(login.status).toBe(302);
      const loc = new URL(login.headers.get('location') ?? '');
      expect(`${loc.origin}${loc.pathname}`).toBe('https://idp.example.com/authorize');
      expect(loc.searchParams.get('client_id')).toBe(oidc.clientId);
      expect(loc.searchParams.get('scope')).toBe(oidc.scope);
    } finally {
      restore();
    }
  });

  it('激活 body 字段非法时忽略该字段，纯 token 激活兼容', async () => {
    const { env, db, cookie } = await envFor();

    const gen = (await (
      await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env)
    ).json()) as { token: string };

    const ok = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 123, clientId: '', scope: 'openid', extra: 'ignored' }),
      },
      env,
    );
    expect(ok.status).toBe(200);
    // issuer=123（非字符串）/ clientId=''（空串）→ 忽略；scope 合法 → 落库；未知键忽略
    expect(db.first('SELECT value FROM instance_config WHERE key = ?', 'oidc_issuer')).toBeNull();
    expect(db.first('SELECT value FROM instance_config WHERE key = ?', 'oidc_client_id')).toBeNull();
    expect(db.first<{ value: string }>('SELECT value FROM instance_config WHERE key = ?', 'oidc_scope')).toEqual({
      value: 'openid',
    });
    expect(db.first<{ role: string }>('SELECT role FROM users WHERE id = ?', 'u_1')).toEqual({ role: 'admin' });
  });

  // --- 守护用例（审核 T1：查询列 ↔ 建表列错位即红） ------------------------

  it('守护：setup 相关表列与迁移建表一致（幻影列/漏列即红）', async () => {
    const { db } = await envFor();
    expect(db.columns('instance_config')).toEqual(['key', 'value', 'updated_at']);
    expect(db.columns('setup_tokens')).toEqual(['token', 'created_at', 'used_at', 'used_by']);
    expect(db.columns('users')).toEqual(['id', 'issuer', 'sub', 'display_name', 'role', 'created_at']);
  });

  it('守护：激活全链路跑完后各行 SELECT * 列集合 == columns()', async () => {
    const { env, db, cookie } = await envFor();
    const gen = (await (
      await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env)
    ).json()) as { token: string };
    const ok = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(ok.status).toBe(200);

    const expectShape = (table: string, row: Record<string, unknown> | null) => {
      expect(Object.keys(row ?? {}).sort()).toEqual([...db.columns(table)].sort());
    };
    expectShape('users', db.first('SELECT * FROM users WHERE id = ?', 'u_1'));
    expectShape('setup_tokens', db.first('SELECT * FROM setup_tokens WHERE token = ?', gen.token));
    expectShape('instance_config', db.first("SELECT * FROM instance_config WHERE key = 'setup_done'"));
    const auditRows = db.query('SELECT * FROM audit_log');
    expect(auditRows.length).toBeGreaterThan(0);
    for (const row of auditRows) {
      expectShape('audit_log', row);
    }
  });

  it('守护：真 schema 约束生效（setup_tokens 重复 token 必须抛错）', async () => {
    const { db } = await envFor();
    db.run('INSERT INTO setup_tokens (token) VALUES (?)', 'once-token');
    // 主键真生效：同一 token 二次插入违反 PK → 抛错
    expect(() => db.run('INSERT INTO setup_tokens (token) VALUES (?)', 'once-token')).toThrow();
    // 注：NULL token 不抛错——SQLite 对未声明 NOT NULL 的 TEXT PRIMARY KEY 允许 NULL
    // （迁移 0002 的 token 列缺 NOT NULL；见报告：真实 schema 发现）。
  });
});

/** 假发现文档（仅 login 需要；test-connection 的完整假 IdP 在 auth-routes.test.ts）。 */
function installFakeDiscovery(issuer: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/.well-known/openid-configuration')) {
      return new Response(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }),
        { status: 200 },
      );
    }
    throw new Error(`fake discovery: unexpected fetch ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
