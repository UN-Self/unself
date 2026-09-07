// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';

import app from '../src/index';

/**
 * 假身份源：拦截全局 fetch（discovery/token），签发真 RS256 id_token。
 * 覆盖 GET /api/auth/login → 302 授权页、GET /api/auth/callback → 签会话、
 * POST /api/auth/logout → 清 Cookie、GET /api/me → 会话态。
 */
const ISSUER = 'https://idp.example.com';
let privateKey: CryptoKey;
let kid: string;

beforeEach(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
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
          scopes_supported: ['openid'],
        }),
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

function env(): Record<string, unknown> {
  return {
    CORE_DB: {
      prepare: (_sql: string) => {
        const chain = {
          bind: () => chain,
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ success: true }),
        };
        return chain;
      },
    },
    JWT_PRIVATE_KEY: undefined,
  };
}

describe('OIDC 登录路由', () => {
  it('未配置 OIDC 时 /api/auth/login 回 503', async () => {
    const res = await app.request('/api/auth/login', { method: 'GET' }, env());
    expect(res.status).toBe(503);
  });

  it('/api/auth/login 302 到授权页并下发流程 Cookie', async () => {
    const restore = installFakeIdp(await issueIdToken('x'));
    try {
      const e = {
        ...env(),
        OIDC_ISSUER: ISSUER,
        OIDC_CLIENT_ID: 'unself-dev',
        OIDC_CLIENT_SECRET: 'dev-secret',
      };
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
    const e = {
      ...env(),
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: 'unself-dev',
      OIDC_CLIENT_SECRET: 'dev-secret',
      JWT_PRIVATE_KEY: pair.privateKeyPem,
    };
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
      const e = {
        ...env(),
        OIDC_ISSUER: ISSUER,
        OIDC_CLIENT_ID: 'unself-dev',
        OIDC_CLIENT_SECRET: 'dev-secret',
      };
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
    const res = await app.request('https://team.example.com/api/me', {}, env());
    expect(res.status).toBe(401);
  });
});
