// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';

import app from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { resetOidcCaches } from '../src/oidc';
import { createCoreDb, type CoreTestDb } from './test-factory';

/** SQLite `datetime('now')` 落库文本语义（UTC，无 T/Z，非 ISO）。 */
const DATETIME_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

beforeEach(() => {
  // 发现文档按 issuer 进程内缓存（15 分钟 TTL）：用例间换 scopes_supported 必须重置
  resetOidcCaches();
});

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

    // 2) 未登录激活 → 纯 401（#55：loginUrl 路径已删——登录在 oidc-config 落库后发起）
    const anon = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      { method: 'POST' },
      env,
    );
    expect(anon.status).toBe(401);
    const anonBody = (await anon.json()) as Record<string, unknown>;
    expect(anonBody).toEqual({ error: 'authentication required' });
    expect('loginUrl' in anonBody).toBe(false);

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

  it('oidc-config：有效 token 落库审计 + 只验不消费（可重复提交改填），返回 loginUrl', async () => {
    const { env, db } = await envFor();

    const gen = (await (
      await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env)
    ).json()) as { token: string };

    const oidc = {
      issuer: 'https://idp.example.com',
      clientId: 'app-1',
      clientSecret: 's3cret',
    };
    const ok = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${gen.token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(oidc),
      },
      env,
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { ok: boolean; loginUrl: string };
    expect(okBody.ok).toBe(true);
    // loginUrl：next 带回带 token 的 setup 页（直线流程第二步）
    const loginUrl = new URL(okBody.loginUrl);
    expect(`${loginUrl.origin}${loginUrl.pathname}`).toBe('https://team.example.com/api/auth/login');
    expect(loginUrl.searchParams.get('next')).toBe(`/setup?token=${gen.token}`);

    // 真库：与 getOidcConfig 读取键一致的 oidc_* 键已落库（无 scope 字段 → 不写 scope，登录时默认三件）
    const configValue = (key: string) =>
      db.first<{ value: string }>('SELECT value FROM instance_config WHERE key = ?', key)?.value ?? null;
    expect(configValue('oidc_issuer')).toBe(oidc.issuer);
    expect(configValue('oidc_client_id')).toBe(oidc.clientId);
    expect(configValue('oidc_client_secret')).toBe(oidc.clientSecret);
    expect(configValue('oidc_scope')).toBeNull();
    // 真库：token 未消费（只验不消费）
    expect(
      db.first<{ used_at: string | null }>('SELECT used_at FROM setup_tokens WHERE token = ?', gen.token),
    ).toEqual({ used_at: null });

    // 改填可重复提交：同一 token 再提交新值 → 覆盖 + 仍不消费
    const again = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${gen.token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...oidc, issuer: 'https://new-idp.example.com' }),
      },
      env,
    );
    expect(again.status).toBe(200);
    expect(configValue('oidc_issuer')).toBe('https://new-idp.example.com');
    expect(
      db.first<{ used_at: string | null }>('SELECT used_at FROM setup_tokens WHERE token = ?', gen.token),
    ).toEqual({ used_at: null });

    // 审计（真 audit_log 表）
    const actions = db.query<{ action: string }>('SELECT action FROM audit_log').map((a) => a.action);
    expect(actions.filter((a) => a === 'oidc_config_stored').length).toBeGreaterThan(0);
  });

  it('oidc-config：无效/已消费 token 拒，缺 token/缺字段 400，封箱后 409', async () => {
    const { env, db, cookie } = await envFor();

    // 无效 token → 403，不落库
    const forged = await app.request(
      'https://team.example.com/api/setup/oidc-config?token=forged-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'https://idp.example.com', clientId: 'c', clientSecret: 's' }),
      },
      env,
    );
    expect(forged.status).toBe(403);
    expect(db.first('SELECT value FROM instance_config WHERE key = ?', 'oidc_issuer')).toBeNull();

    // 缺 token → 400
    const noToken = await app.request(
      'https://team.example.com/api/setup/oidc-config',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'https://idp.example.com', clientId: 'c', clientSecret: 's' }),
      },
      env,
    );
    expect(noToken.status).toBe(400);

    // 缺字段 → 400（用合法未消费 token：token 门禁在 body 校验之前，先过门禁）
    const gen = (await (
      await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env)
    ).json()) as { token: string };
    const missing = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${gen.token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'https://idp.example.com' }),
      },
      env,
    );
    expect(missing.status).toBe(400);
    expect(db.first('SELECT value FROM instance_config WHERE key = ?', 'oidc_issuer')).toBeNull();

    // 一个合法生成的 token 先激活（消费），随后 oidc-config 再提交 → 403
    const gen2 = (await (
      await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env)
    ).json()) as { token: string };
    const activate = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen2.token}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(activate.status).toBe(200);
    const afterConsume = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${gen2.token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'https://idp.example.com', clientId: 'c', clientSecret: 's' }),
      },
      env,
    );
    // 封箱优先：setup_done 已置位 → 409（两端点同响应）
    expect(afterConsume.status).toBe(409);
  });

  it('直线流程全链：oidc-config 落库 → 登录可通（表优先）→ 回 setup 激活提权封箱', async () => {
    const { env, db, cookie } = await envFor();

    const gen = (await (
      await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env)
    ).json()) as { token: string };

    // 第一步：带 token 提交向导字段（env 无 OIDC_* 兜底——全新部署真实场景）
    const oidc = {
      issuer: 'https://idp.example.com',
      clientId: 'app-1',
      clientSecret: 's3cret',
    };
    const save = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${gen.token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(oidc),
      },
      env,
    );
    expect(save.status).toBe(200);

    // 第二步：未登录也能发起登录（配置来自表，不再 503）
    const restore = installFakeDiscovery(oidc.issuer);
    try {
      const login = await app.request('https://team.example.com/api/auth/login', {}, env);
      expect(login.status).toBe(302);
      const loc = new URL(login.headers.get('location') ?? '');
      expect(`${loc.origin}${loc.pathname}`).toBe('https://idp.example.com/authorize');
      expect(loc.searchParams.get('client_id')).toBe(oidc.clientId);
      expect(loc.searchParams.get('scope')).toBe('openid profile email'); // 发现文档无 scopes_supported → 维持三件
    } finally {
      restore();
    }

    // 第三步：登录回来带会话 + token → 激活提权封箱
    const activate = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(activate.status).toBe(200);
    const body = (await activate.json()) as { ok: boolean; user: { role: string } };
    expect(body.ok).toBe(true);
    expect(body.user.role).toBe('admin');
    expect(db.first<{ role: string }>('SELECT role FROM users WHERE id = ?', 'u_1')).toEqual({ role: 'admin' });
    expect(db.first('SELECT value FROM instance_config WHERE key = ?', 'setup_done')).toEqual({ value: '1' });
    expect(
      db.first<{ used_at: string | null }>('SELECT used_at FROM setup_tokens WHERE token = ?', gen.token),
    ).not.toEqual({ used_at: null });

    // 封箱后：oidc-config / activate / setup-token 全 409
    const after = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${gen.token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(oidc),
      },
      env,
    );
    expect(after.status).toBe(409);
    const replay = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(replay.status).toBe(409);
    const newToken = await app.request(
      'https://team.example.com/api/admin/setup-token',
      { method: 'POST' },
      env,
    );
    expect(newToken.status).toBe(409);
  });

  it('scope：按 discovery scopes_supported 过滤（Stalwart 无 email → 只发 openid；交集空只 openid；字段缺失三件）', async () => {
    const cases: Array<{ scopes?: string[]; expected: string }> = [
      // Stalwart 0.16 实测：无 profile/email，只有 openid 进交集
      { scopes: ['openid', 'offline_access', 'mail', 'contacts', 'calendars'], expected: 'openid' },
      // 交集为空 → 只发 openid
      { scopes: ['offline_access'], expected: 'openid' },
      // scopes_supported 字段缺失 → 维持三件
      { expected: 'openid profile email' },
    ];

    for (const c of cases) {
      // 同一 issuer 的发现文档 15 分钟缓存：每种子场景都要重置才能拿到各自的 scopes_supported
      resetOidcCaches();
      const { env } = await envFor();
      const gen = (await (
        await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env)
      ).json()) as { token: string };
      const oidc = { issuer: 'https://idp.example.com', clientId: 'app-1', clientSecret: 's3cret' };
      await app.request(
        `https://team.example.com/api/setup/oidc-config?token=${gen.token}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(oidc),
        },
        env,
      );

      const restore = installFakeDiscovery(oidc.issuer, c.scopes);
      try {
        const login = await app.request('https://team.example.com/api/auth/login', {}, env);
        expect(login.status).toBe(302);
        const loc = new URL(login.headers.get('location') ?? '');
        expect(loc.searchParams.get('scope')).toBe(c.expected);
      } finally {
        restore();
      }
    }
  });

  it('并发双激活同一 token：仅一次成功（consumeSetupToken 原子化）', async () => {
    const { env, db, cookie } = await envFor();

    const gen = (await (
      await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env)
    ).json()) as { token: string };

    const activate = () =>
      app.request(
        `https://team.example.com/api/setup/activate?token=${gen.token}`,
        { method: 'POST', headers: { cookie } },
        env,
      );
    const [a, b] = await Promise.all([activate(), activate()]);
    const statuses = [a.status, b.status];

    // 契约：同一 token 并发双激活只有一次成功；另一次被拒（403 已使用 / 409 已封死）
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 403 || s === 409)).toHaveLength(1);

    // 真库：只有一次激活落痕——setup_done 置位、升管理员、审计仅一条 setup_activated
    expect(
      db.query<{ value: string }>("SELECT value FROM instance_config WHERE key = 'setup_done'"),
    ).toEqual([{ value: '1' }]);
    expect(db.first<{ role: string }>('SELECT role FROM users WHERE id = ?', 'u_1')).toEqual({ role: 'admin' });
    expect(
      db.query<{ action: string }>("SELECT action FROM audit_log WHERE action = 'setup_activated'"),
    ).toHaveLength(1);
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

/** 假发现文档（仅 login 需要；test-connection 的完整假 IdP 在 auth-routes.test.ts）。
 *  scopes: 传入则产出 scopes_supported；不传则字段缺失（对应「维持三件」分支）。 */
function installFakeDiscovery(issuer: string, scopes?: string[]) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/.well-known/openid-configuration')) {
      const metadata: Record<string, unknown> = {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      };
      if (scopes !== undefined) {
        metadata.scopes_supported = scopes;
      }
      return new Response(JSON.stringify(metadata), { status: 200 });
    }
    throw new Error(`fake discovery: unexpected fetch ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
