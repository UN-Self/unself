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

async function issueIdToken(
  nonce: string,
  sub = 'u-123',
  claims: Record<string, unknown> = { name: '黄一', email: 'huang@example.com' },
): Promise<string> {
  return new SignJWT({ ...claims, nonce })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(ISSUER)
    .setAudience('unself-dev')
    .setIssuedAt()
    .setExpirationTime('10m')
    .setSubject(sub)
    .sign(privateKey);
}

/** 可选 userinfo 端点桩：发现文档带 userinfo_endpoint，请求时回 body 并记录 Authorization。 */
interface FakeUserInfo {
  endpoint: string;
  body: Record<string, unknown>;
  onRequest?: (authorization: string | null) => void;
  /** 并发用例的会合点：两个回调都到 userinfo 才放行（暴露消费段 TOCTOU）。 */
  beforeRespond?: () => Promise<void>;
}

function installFakeIdp(idToken: string, userinfo?: FakeUserInfo, idTokenByCode?: Map<string, string>) {
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
          ...(userinfo ? { userinfo_endpoint: userinfo.endpoint } : {}),
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
      // 并发用例：按授权码发各自 sub 的 id_token；否则发固定 idToken
      const code = new URLSearchParams(String(init?.body ?? '')).get('code') ?? '';
      return new Response(
        JSON.stringify({ access_token: 'at', token_type: 'Bearer', id_token: idTokenByCode?.get(code) ?? idToken }),
        { status: 200 },
      );
    }
    if (userinfo && url === userinfo.endpoint) {
      userinfo.onRequest?.(new Headers(init?.headers).get('authorization'));
      await userinfo.beforeRespond?.();
      return new Response(JSON.stringify(userinfo.body), { status: 200 });
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

  it('callback JIT 建档后把 invited_email 悬挂通知补投给新用户（#19）', async () => {
    const { generateInstanceKeyPair } = await import('../src/keys');
    const pair = await generateInstanceKeyPair();
    const { e: baseEnv, db } = env();
    const e = { ...oidcEnv(baseEnv), JWT_PRIVATE_KEY: pair.privateKeyPem };
    // 批准时被邀请人尚无档案：站内通知暂存悬挂收件人（大小写不同也应补投）
    db.run(
      "INSERT INTO notifications (id, user_id, invited_email, type, payload) VALUES (?, NULL, ?, 'invite_result', '{}')",
      'n_hanging',
      'Huang@Example.com',
    );

    const restoreLogin = installFakeIdp('unused');
    const login = await app.request('https://team.example.com/api/auth/login', {}, e);
    const rawCookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const flow = JSON.parse(decodeURIComponent(rawCookie.replace('unself_oidc_flow=', ''))) as {
      state: string;
      nonce: string;
    };
    restoreLogin();

    const restore = installFakeIdp(await issueIdToken(flow.nonce));
    try {
      const callback = await app.request(
        `https://team.example.com/api/auth/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
        { headers: { cookie: `unself_oidc_flow=${encodeURIComponent(JSON.stringify(flow))}` }, redirect: 'manual' },
        e,
      );
      expect(callback.status).toBe(302);

      const user = db.first<{ id: string }>(
        'SELECT id FROM users WHERE issuer = ? AND sub = ?',
        ISSUER,
        'u-123',
      );
      expect(user).not.toBeNull();
      const bound = db.first<{ user_id: string | null; invited_email: string | null }>(
        'SELECT user_id, invited_email FROM notifications WHERE id = ?',
        'n_hanging',
      );
      expect(bound!.user_id).toBe(user!.id);
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
  /** 按定制的发现文档起桩（#17：黄牌规则只看 discovery，不碰 token/jwks）。 */
  function stubDiscovery(metadata: Record<string, unknown>): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify(metadata), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  /** 起桩 + 打点 test-connection，回 warnings（同步清理 fetch，防用例间串刺）。 */
  async function probeWarnings(metadata: Record<string, unknown>): Promise<string[]> {
    const restore = stubDiscovery(metadata);
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
      const body = (await res.json()) as { ok: boolean; warnings: string[] };
      expect(body.ok).toBe(true);
      return body.warnings;
    } finally {
      restore();
    }
  }

  it('合法 https issuer：回文档 issuer + 授权/令牌端点', async () => {
    // 完整 IdP（带 userinfo_endpoint）→ 无黄牌
    const restore = installFakeIdp('unused', { endpoint: `${ISSUER}/userinfo`, body: {} });
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
        warnings: [],
      });
    } finally {
      restore();
    }
  });

  it('claims_supported 声明不含 nonce → 黄牌提醒登录可能失败（#17）', async () => {
    const warnings = await probeWarnings({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: JWKS_URI,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      claims_supported: ['sub', 'email', 'name'],
    });
    expect(warnings).toContain('该 IdP 可能无法完成登录（不回显 nonce）');
  });

  it('无 userinfo_endpoint 且 claims_supported 无邮箱 claim → 黄牌提醒邮箱拿不到（#17）', async () => {
    const warnings = await probeWarnings({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: JWKS_URI,
      claims_supported: ['sub', 'nonce', 'name'],
    });
    expect(warnings).toContain('拿不到邮箱，邀请/通知功能受限');
  });

  it('无 userinfo_endpoint 但 claims_supported 含 email → 不出邮箱黄牌（可从 id_token 拿）（#17）', async () => {
    const warnings = await probeWarnings({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: JWKS_URI,
      claims_supported: ['sub', 'nonce', 'email'],
    });
    expect(warnings).not.toContain('拿不到邮箱，邀请/通知功能受限');
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

// ---------------------------------------------------------------------------
// #49 弱化实例首登：userinfo 兜底 + email 匹配消费邀请（认证路由级行为）
// ---------------------------------------------------------------------------

/** 登录可用环境：真 SQLite + 真实例签名私钥（回调要签会话 Cookie）。 */
async function loginEnv(): Promise<{ e: Record<string, unknown>; db: CoreTestDb }> {
  const { generateInstanceKeyPair } = await import('../src/keys');
  const pair = await generateInstanceKeyPair();
  const { e: baseEnv, db } = env();
  return { e: { ...oidcEnv(baseEnv), JWT_PRIVATE_KEY: pair.privateKeyPem }, db };
}

/** 发起一次登录拿流程 Cookie（发现文档请求需假 IdP 在位）。 */
async function acquireFlow(e: Record<string, unknown>): Promise<{ state: string; nonce: string }> {
  const login = await app.request('https://team.example.com/api/auth/login', {}, e);
  expect(login.status).toBe(302);
  const rawCookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return JSON.parse(decodeURIComponent(rawCookie.replace('unself_oidc_flow=', ''))) as {
    state: string;
    nonce: string;
  };
}

/**
 * 走一遍完整登录回跳：先拿流程 Cookie，再按其中 nonce 签发 id_token 调 callback。
 * claims = id_token 载荷；userinfo 传入时发现文档带 userinfo_endpoint 并拦截其请求。
 */
async function runLogin(
  e: Record<string, unknown>,
  claims: Record<string, unknown>,
  opts: { sub?: string; userinfo?: FakeUserInfo } = {},
): Promise<Response> {
  const restoreLogin = installFakeIdp('unused', opts.userinfo);
  const login = await app.request('https://team.example.com/api/auth/login', {}, e);
  expect(login.status).toBe(302);
  const rawCookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const flow = JSON.parse(decodeURIComponent(rawCookie.replace('unself_oidc_flow=', ''))) as {
    state: string;
    nonce: string;
  };
  restoreLogin();
  const restore = installFakeIdp(await issueIdToken(flow.nonce, opts.sub, claims), opts.userinfo);
  try {
    return await app.request(
      `https://team.example.com/api/auth/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      {
        headers: { cookie: `unself_oidc_flow=${encodeURIComponent(JSON.stringify(flow))}` },
        redirect: 'manual',
      },
      e,
    );
  } finally {
    restore();
  }
}

describe('弱化实例首登：#49 userinfo 兜底 + email 匹配消费邀请', () => {
  const USERINFO: FakeUserInfo = {
    endpoint: `${ISSUER}/userinfo`,
    body: { name: '爱丽丝', email: 'alice@personal.example' },
  };

  it('id_token 缺 email/name → 用 access_token 调 userinfo 补齐后建档', async () => {
    const { e, db } = await loginEnv();
    let authorization: string | null = null;
    const res = await runLogin(e, {}, {
      userinfo: { ...USERINFO, onRequest: (h) => { authorization = h; } },
    });
    expect(res.status).toBe(302);
    // 用 token 端点发的 access_token（仅此步用，不落库）
    expect(authorization).toBe('Bearer at');
    expect(
      db.first<{ display_name: string; email: string }>(
        'SELECT display_name, email FROM users WHERE issuer = ? AND sub = ?',
        ISSUER,
        'u-123',
      ),
    ).toEqual({ display_name: '爱丽丝', email: 'alice@personal.example' });
  });

  it('id_token 齐备 → 不调 userinfo，以 id_token 为准', async () => {
    const { e, db } = await loginEnv();
    let calls = 0;
    const res = await runLogin(e, { name: '黄一', email: 'huang@example.com' }, {
      userinfo: { ...USERINFO, onRequest: () => { calls += 1; } },
    });
    expect(res.status).toBe(302);
    expect(calls).toBe(0);
    expect(
      db.first<{ display_name: string; email: string }>(
        'SELECT display_name, email FROM users WHERE issuer = ? AND sub = ?',
        ISSUER,
        'u-123',
      ),
    ).toEqual({ display_name: '黄一', email: 'huang@example.com' });
  });

  it('id_token 仅有 email、无 name → 也调 userinfo 补名字，email 仍以 id_token 为准', async () => {
    const { e, db } = await loginEnv();
    let authorization: string | null = null;
    const res = await runLogin(e, { email: 'huang@example.com' }, {
      userinfo: {
        endpoint: `${ISSUER}/userinfo`,
        body: { name: '爱丽丝', email: 'alice@personal.example' }, // userinfo 邮箱与 id_token 不同
        onRequest: (h) => { authorization = h; },
      },
    });
    expect(res.status).toBe(302);
    expect(authorization).toBe('Bearer at');
    expect(
      db.first<{ display_name: string; email: string }>(
        'SELECT display_name, email FROM users WHERE issuer = ? AND sub = ?',
        ISSUER,
        'u-123',
      ),
    ).toEqual({ display_name: '爱丽丝', email: 'huang@example.com' });
  });

  it('id_token 空 email/name → 按缺失处理并由 userinfo 补齐', async () => {
    const { e, db } = await loginEnv();
    const res = await runLogin(e, { email: '', name: '' }, { userinfo: USERINFO });
    expect(res.status).toBe(302);
    expect(
      db.first<{ display_name: string; email: string }>(
        'SELECT display_name, email FROM users WHERE issuer = ? AND sub = ?',
        ISSUER,
        'u-123',
      ),
    ).toEqual({ display_name: '爱丽丝', email: 'alice@personal.example' });
  });

  it('approved 邀请命中（大小写不敏感）→ 置 consumed + 回填 personal_email', async () => {
    const { e, db } = await loginEnv();
    db.run(
      "INSERT INTO invites (token_hash, status, personal_email, email_prefix, display_name, expires_at) VALUES ('h1', 'approved', 'Alice@Personal.Example', 'alice', 'Alice', '2027-01-01 00:00:00')",
    );
    const res = await runLogin(e, { name: '爱丽丝', email: 'alice@personal.example' });
    expect(res.status).toBe(302);
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', 'h1')).toEqual({
      status: 'consumed',
    });
    expect(
      db.first<{ email: string; personal_email: string }>(
        'SELECT email, personal_email FROM users WHERE issuer = ? AND sub = ?',
        ISSUER,
        'u-123',
      ),
    ).toEqual({ email: 'alice@personal.example', personal_email: 'Alice@Personal.Example' });
  });

  it('无该邮箱邀请 → 正常建档（email 落库），他人邀请不动', async () => {
    const { e, db } = await loginEnv();
    db.run(
      "INSERT INTO invites (token_hash, status, personal_email, email_prefix, display_name, expires_at) VALUES ('h2', 'approved', 'bob@personal.example', 'bob', 'Bob', '2027-01-01 00:00:00')",
    );
    const res = await runLogin(e, { name: '爱丽丝', email: 'alice@personal.example' });
    expect(res.status).toBe(302);
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', 'h2')).toEqual({
      status: 'approved',
    });
    expect(
      db.first<{ email: string; personal_email: string | null }>(
        'SELECT email, personal_email FROM users WHERE issuer = ? AND sub = ?',
        ISSUER,
        'u-123',
      ),
    ).toEqual({ email: 'alice@personal.example', personal_email: null });
  });

  it('邀请已消费 → 不重复消费、不覆盖档案，用户照常建档', async () => {
    const { e, db } = await loginEnv();
    db.run(
      "INSERT INTO invites (token_hash, status, personal_email, email_prefix, display_name, expires_at) VALUES ('h3', 'consumed', 'alice@personal.example', 'alice', 'Alice', '2027-01-01 00:00:00')",
    );
    const res = await runLogin(e, { name: '爱丽丝', email: 'alice@personal.example' });
    expect(res.status).toBe(302);
    expect(db.query('SELECT status FROM invites')).toEqual([{ status: 'consumed' }]);
    expect(
      db.first<{ email: string; personal_email: string | null }>(
        'SELECT email, personal_email FROM users WHERE issuer = ? AND sub = ?',
        ISSUER,
        'u-123',
      ),
    ).toEqual({ email: 'alice@personal.example', personal_email: null });
  });

  it('同邮箱并发首登（不同 sub）→ approved 邀请只消费一次（原子消费）', async () => {
    const { e, db } = await loginEnv();
    db.run(
      "INSERT INTO invites (token_hash, status, personal_email, email_prefix, display_name, expires_at) VALUES ('h4', 'approved', 'Alice@Personal.Example', 'alice', 'Alice', '2027-01-01 00:00:00')",
    );

    // userinfo 会合点：两回调都到 userinfo 才放行，保证两请求同时进入消费段（暴露 TOCTOU）
    let arrived = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    const userinfo: FakeUserInfo = {
      endpoint: `${ISSUER}/userinfo`,
      body: { name: '爱丽丝', email: 'alice@personal.example' },
      beforeRespond: async () => {
        arrived += 1;
        if (arrived === 2) release();
        await bothArrived;
      },
    };

    // 两条流程 Cookie（只需发现文档，带 userinfo_endpoint 进缓存）
    const restoreDiscovery = installFakeIdp('unused', userinfo);
    const flowA = await acquireFlow(e);
    const flowB = await acquireFlow(e);
    restoreDiscovery();

    // id_token 缺 email/name → 两回调都走 userinfo 兜底；按授权码发各自 sub 的 id_token
    const idTokens = new Map([
      ['c-a', await issueIdToken(flowA.nonce, 'sub-a', {})],
      ['c-b', await issueIdToken(flowB.nonce, 'sub-b', {})],
    ]);
    const restore = installFakeIdp('', userinfo, idTokens);
    try {
      const callback = (code: string, flow: { state: string; nonce: string }) =>
        app.request(
          `https://team.example.com/api/auth/callback?code=${code}&state=${encodeURIComponent(flow.state)}`,
          {
            headers: { cookie: `unself_oidc_flow=${encodeURIComponent(JSON.stringify(flow))}` },
            redirect: 'manual',
          },
          e,
        );
      const [a, b] = await Promise.all([callback('c-a', flowA), callback('c-b', flowB)]);
      expect(a.status).toBe(302);
      expect(b.status).toBe(302);
    } finally {
      restore();
    }

    // 并发双登录只消费一次：邀请单条 consumed，personal_email 只绑到一个档案
    expect(db.query('SELECT status FROM invites')).toEqual([{ status: 'consumed' }]);
    expect(
      db.query(
        'SELECT personal_email FROM users WHERE issuer = ? AND personal_email IS NOT NULL',
        ISSUER,
      ),
    ).toHaveLength(1);
    expect(db.query('SELECT id FROM users WHERE issuer = ?', ISSUER)).toHaveLength(2);
  });
});
