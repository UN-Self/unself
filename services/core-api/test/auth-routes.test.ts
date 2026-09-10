// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT, exportJWK, type JWK } from 'jose';

import app from '../src/index';
import { resetOidcCaches } from '../src/oidc';
import { createCoreDb, type CoreTestDb } from './test-factory';

/**
 * 假身份源：拦截全局 fetch（discovery/token/jwks），签发真 RS256 id_token。
 * 覆盖 GET /api/auth/login → 302 授权页、GET /api/auth/callback → 签会话、
 * POST /api/auth/logout → 清 Cookie、GET /api/me → 会话态、
 * POST /api/oidc/test-connection → 服务端探测。
 *
 * CORE_DB 用共享 test-factory 的真 SQLite（migrations/core/*.sql 真建表）：
 * 回调 JIT 建档真写 users 表，SUCCESS/UNIQUE 约束为真约束。
 */
const ISSUER = 'https://idp.example.com';
const JWKS_URI = `${ISSUER}/jwks`;
let privateKey: CryptoKey;
let publicJwk: JWK;
let kid: string;

beforeEach(async () => {
  resetOidcCaches(); // 发现文档 + JWKS 集合按 issuer 缓存，换钥测试必须重置
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  kid = 'test-key';
});

async function issueIdToken(nonce: string, sub = 'u-123'): Promise<string> {
  return new SignJWT({ name: '黄一', email: 'huang@example.com', nonce })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(ISSUER)
    .setAudience('unself-dev')
    .setIssuedAt()
    .setExpirationTime('10m')
    .setSubject(sub)
    .sign(privateKey);
}

function installFakeIdp(idToken: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/.well-known/openid-configuration')) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: JWKS_URI,
          scopes_supported: ['openid'],
        }),
        { status: 200 },
      );
    }
    if (url === JWKS_URI) {
      return new Response(
        JSON.stringify({ keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] }),
        { status: 200 },
      );
    }
    if (url === `${ISSUER}/token`) {
      return new Response(
        JSON.stringify({ access_token: 'at', token_type: 'Bearer', id_token: idToken }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * 用例环境：真 SQLite（createCoreDb，加载 migrations/core/*.sql）。
 * db 暴露给用例查真库（JIT 建档守卫断言），e 即 app.request 的 env。
 */
function env(): { e: Record<string, unknown>; db: CoreTestDb } {
  const db = createCoreDb();
  return { e: { CORE_DB: db.d1, JWT_PRIVATE_KEY: undefined }, db };
}

/** OIDC 配置齐备（环境变量兜底路径）的请求环境。 */
function oidcEnv(base: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'unself-dev',
    OIDC_CLIENT_SECRET: 'dev-secret',
  };
}

describe('OIDC 登录路由', () => {
  it('未配置 OIDC 时 /api/auth/login 回 503', async () => {
    const { e } = env();
    const res = await app.request('/api/auth/login', { method: 'GET' }, e);
    expect(res.status).toBe(503);
  });

  it('/api/auth/login 302 到授权页并下发流程 Cookie', async () => {
    const restore = installFakeIdp(await issueIdToken('x'));
    try {
      const e = oidcEnv(env().e);
      const res = await app.request('https://team.example.com/api/auth/login', {}, e);
      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      expect(location.startsWith(`${ISSUER}/authorize`)).toBe(true);
      expect(location).toContain('response_type=code');
      expect(location).toContain('code_challenge_method=S256');
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('unself_oidc_flow=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Secure');
    } finally {
      restore();
    }
  });

  it('callback 完整链路：换 token → JIT 建档 → 会话 Cookie → /api/me 可读', async () => {
    const { generateInstanceKeyPair } = await import('../src/keys');
    const pair = await generateInstanceKeyPair();
    const { e: baseEnv, db } = env();
    const e = { ...oidcEnv(baseEnv), JWT_PRIVATE_KEY: pair.privateKeyPem };
    // 先拿流程 Cookie（需要假身份源），拿到 nonce 后再签发对应 id_token
    const restoreLogin = installFakeIdp('unused');
    const login = await app.request('https://team.example.com/api/auth/login', {}, e);
    const rawCookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const flowValue = rawCookie.replace('unself_oidc_flow=', '');
    expect(flowValue).toBeTruthy();
    const flow = JSON.parse(decodeURIComponent(flowValue)) as {
      state: string;
      nonce: string;
    };
    restoreLogin();
    const restore = installFakeIdp(await issueIdToken(flow.nonce));
    try {
      // callback：带 state 与流程 Cookie
      const callback = await app.request(
        `https://team.example.com/api/auth/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
        { headers: { cookie: `unself_oidc_flow=${encodeURIComponent(JSON.stringify(flow))}` }, redirect: 'manual' },
        e,
      );
      expect(callback.status).toBe(302);
      // callback 会下发两条 set-cookie（清 flow + 发会话）；取会话那条
      const allCookies = (callback.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      const sessionCookie = allCookies.find((cookie) => cookie.startsWith('unself_session=')) ?? '';
      expect(sessionCookie).toContain('HttpOnly');

      // JIT 建档：真 users 表落行（issuer+sub 唯一键）
      const userRow = db.first<{ id: string; issuer: string; sub: string; display_name: string; role: string }>(
        'SELECT id, issuer, sub, display_name, role FROM users WHERE issuer = ? AND sub = ?',
        ISSUER,
        'u-123',
      );
      expect(userRow).not.toBeNull();
      expect(userRow!.role).toBe('user');
      expect(userRow!.display_name).toBe('黄一');
      expect(userRow!.issuer).toBe(ISSUER);
      expect(userRow!.sub).toBe('u-123');

      // 同 issuer+sub 再跑一次 callback：复用同一行（UNIQUE(issuer,sub) 真生效，不重复建档）
      const callback2 = await app.request(
        `https://team.example.com/api/auth/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
        { headers: { cookie: `unself_oidc_flow=${encodeURIComponent(JSON.stringify(flow))}` }, redirect: 'manual' },
        e,
      );
      expect(callback2.status).toBe(302);
      const again = db.first<{ id: string }>(
        'SELECT id FROM users WHERE issuer = ? AND sub = ?',
        ISSUER,
        'u-123',
      );
      expect(again!.id).toBe(userRow!.id);
      expect(
        db.query('SELECT id FROM users WHERE issuer = ? AND sub = ?', ISSUER, 'u-123'),
      ).toHaveLength(1);

      // 用会话访问 /api/me
      const session = sessionCookie.split(';')[0]!.replace('unself_session=', '');
      const me = await app.request(
        'https://team.example.com/api/me',
        { headers: { cookie: `unself_session=${session}` } },
        e,
      );
      expect(me.status).toBe(200);
      const body = (await me.json()) as { authenticated: boolean; user: { name: string } };
      expect(body.authenticated).toBe(true);
      expect(body.user.name).toBe('黄一');

      // 登出：清 Cookie
      const logout = await app.request(
        'https://team.example.com/api/auth/logout',
        { method: 'POST', headers: { cookie: `unself_session=${session}` } },
        e,
      );
      expect(logout.status).toBe(200);
      expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    } finally {
      restore();
    }
  });

  it('callback 无流程 Cookie 回 400', async () => {
    const restore = installFakeIdp(await issueIdToken('n'));
    try {
      const e = oidcEnv(env().e);
      const res = await app.request(
        'https://team.example.com/api/auth/callback?code=abc&state=st',
        {},
        e,
      );
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });

  it('未认证 /api/me 回 401', async () => {
    const { e } = env();
    const res = await app.request('https://team.example.com/api/me', {}, e);
    expect(res.status).toBe(401);
  });

  it('/api/me 带 role（admin 升格后真值来自 users 表服务端会话）', async () => {
    const { generateInstanceKeyPair } = await import('../src/keys');
    const pair = await generateInstanceKeyPair();
    const { e, db } = env();
    db.run(
      'INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)',
      'u_admin',
      ISSUER,
      'a-1',
      '管理',
      'admin',
    );
    const { createSessionToken } = await import('../src/session');
    const token = await createSessionToken(
      { uid: 'u_admin', iss: ISSUER, sub: 'a-1', name: '管理' },
      pair.privateKeyPem,
    );
    const res = await app.request(
      'https://team.example.com/api/me',
      { headers: { cookie: `unself_session=${token}` } },
      { ...e, JWT_PRIVATE_KEY: pair.privateKeyPem },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: true,
      user: { id: 'u_admin', name: '管理', issuer: ISSUER, sub: 'a-1', role: 'admin' },
    });
  });

  // --- 守护用例（审核 T1：查询列 ↔ 建表列错位即红） ------------------------

  it('守护：users 表列与 JIT 行结构 == 迁移建表列（幻影列/漏列即红）', async () => {
    const { generateInstanceKeyPair } = await import('../src/keys');
    const pair = await generateInstanceKeyPair();
    const { e: baseEnv, db } = env();
    expect(db.columns('users')).toEqual([
      'id',
      'issuer',
      'sub',
      'display_name',
      'email',
      'personal_email',
      'role',
      'status',
      'created_at',
    ]);
    const e = { ...oidcEnv(baseEnv), JWT_PRIVATE_KEY: pair.privateKeyPem };

    const restoreLogin = installFakeIdp('unused');
    const login = await app.request('https://team.example.com/api/auth/login', {}, e);
    const flow = JSON.parse(
      decodeURIComponent((login.headers.get('set-cookie') ?? '').split(';')[0]!.replace('unself_oidc_flow=', '')),
    ) as { state: string; nonce: string };
    restoreLogin();
    const restore = installFakeIdp(await issueIdToken(flow.nonce));
    try {
      const callback = await app.request(
        `https://team.example.com/api/auth/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
        { headers: { cookie: `unself_oidc_flow=${encodeURIComponent(JSON.stringify(flow))}` }, redirect: 'manual' },
        e,
      );
      expect(callback.status).toBe(302);

      // JIT 建档后：真库全字段行的列集合必须与建表列一致
      const row = db.first<Record<string, unknown>>(
        'SELECT * FROM users WHERE issuer = ? AND sub = ?',
        ISSUER,
        'u-123',
      );
      expect(row).not.toBeNull();
      expect(Object.keys(row ?? {}).sort()).toEqual([...db.columns('users')].sort());
    } finally {
      restore();
    }
  });
});

describe('POST /api/oidc/test-connection（服务端代理探测，#44）', () => {
  it('合法 https issuer：回文档 issuer + 授权/令牌端点', async () => {
    const restore = installFakeIdp('unused');
    try {
      const { e } = env();
      const res = await app.request(
        'https://team.example.com/api/oidc/test-connection',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ issuer: ISSUER }),
        },
        e,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
      });
    } finally {
      restore();
    }
  });

  it('发现文档缺失 jwks_uri → 502 discovery failed（不透传内部错误）', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/.well-known/openid-configuration')) {
        // 缺 jwks_uri：标准 IdP 必有，缺失即 discover 抛错
        return new Response(
          JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    try {
      const { e } = env();
      const res = await app.request(
        'https://team.example.com/api/oidc/test-connection',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ issuer: ISSUER }),
        },
        e,
      );
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: 'discovery failed' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('http issuer（非 test 环境）→ 400 issuer must be https', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { e } = env();
      const res = await app.request(
        'https://team.example.com/api/oidc/test-connection',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ issuer: 'http://insecure.example.com' }),
        },
        e,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'issuer must be https' });
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('非法 URL issuer → 400 issuer must be https（不触发 discover）', async () => {
    const { e } = env();
    const res = await app.request(
      'https://team.example.com/api/oidc/test-connection',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'not a url' }),
      },
      e,
    );
    expect(res.status).toBe(400);
  });

  it('body 缺 issuer → 400', async () => {
    const { e } = env();
    const res = await app.request(
      'https://team.example.com/api/oidc/test-connection',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
      e,
    );
    expect(res.status).toBe(400);
  });
});
