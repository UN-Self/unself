// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

import app from '../src/index';
import { resetOidcCaches } from '../src/oidc';
import { createCoreDb, type CoreTestDb } from './test-factory';

/**
 * OIDC callback 失败态（#60 T4）：
 * exchangeAuthorizationCode 抛错（state 不匹配 / id_token 过期 / IdP 回跳 error）
 * 不得变 500，统一 302 回 /login?error=<短错误码>（LoginView.vue 消费 route.query.error）；
 * 流程 Cookie 缺失 / JSON 损坏仍保持 400。
 * 假 IdP + 真 RS256 密钥（jose）签发 id_token；resetOidcCaches 隔离发现/JWKS 缓存。
 */

const ISSUER = 'https://idp.example.com';
const JWKS_URI = `${ISSUER}/jwks`;
let privateKey: CryptoKey;
let publicJwk: JWK;
const kid = 'test-key';

beforeEach(async () => {
  resetOidcCaches(); // 发现文档 + JWKS 集合按 issuer 缓存，换钥用例必须重置
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
});

/** 签发 id_token（exp 可传过去时间模拟过期；jose 真签名，走 RS256 验签）。 */
async function issueIdToken(opts: { nonce: string; exp?: number; sub?: string }): Promise<string> {
  return new SignJWT({ name: '黄一', email: 'huang@example.com', nonce: opts.nonce })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(ISSUER)
    .setAudience('unself-dev')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 600)
    .setSubject(opts.sub ?? 'u-123')
    .sign(privateKey);
}

/** 假身份源：拦截全局 fetch（discovery/token/jwks），与 auth-routes 测试同模式（自复制）。 */
function installFakeIdp(idToken: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
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

/** 共享 test-factory 真库（#60 标准）：每个用例独立 sqlite + 真迁移，不手搓假 D1。 */
const openDbs: CoreTestDb[] = [];

/** 真库 + 环境变量注入 OIDC 配置（instance_config 为空表时走 env 兑底）。 */
function env(): Record<string, unknown> {
  const db = createCoreDb();
  openDbs.push(db);
  return {
    CORE_DB: db.d1,
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'unself-dev',
    OIDC_CLIENT_SECRET: 'dev-secret',
    JWT_PRIVATE_KEY: undefined,
  };
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()!.close();
});

/** 走一次真实登录流程（假 IdP）取流程 Cookie 与其中 state/nonce。 */
async function acquireFlowCookie(e: Record<string, unknown>): Promise<{ cookie: string; flow: { state: string; nonce: string } }> {
  const login = await app.request('https://team.example.com/api/auth/login', {}, e);
  expect(login.status).toBe(302);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(cookie).toContain('unself_oidc_flow=');
  const flow = JSON.parse(decodeURIComponent(cookie.replace('unself_oidc_flow=', ''))) as {
    state: string;
    nonce: string;
  };
  return { cookie, flow };
}

describe('GET /api/auth/callback 失败态（#60 T4）', () => {
  it('state 不匹配 → 302 /login?error=oidc_state_mismatch', async () => {
    const restore = installFakeIdp('unused');
    try {
      const e = env();
      const { cookie } = await acquireFlowCookie(e);
      const res = await app.request(
        `https://team.example.com/api/auth/callback?code=abc&state=forged-state`,
        { headers: { cookie } },
        e,
      );
      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      expect(location).toContain('/login?error=');
      expect(location).toContain('oidc_state_mismatch');
    } finally {
      restore();
    }
  });

  it('id_token 过期（exp 在过去）→ 302 /login?error=oidc_token_expired', async () => {
    // 先拿流程 Cookie（换钥后伪造的过期 token 不能复用登录时的签发）
    const restoreLogin = installFakeIdp('unused');
    const e = env();
    const { cookie, flow } = await acquireFlowCookie(e);
    restoreLogin();
    const stale = await issueIdToken({ nonce: flow.nonce, exp: Math.floor(Date.now() / 1000) - 120 });
    const restore = installFakeIdp(stale);
    try {
      const res = await app.request(
        `https://team.example.com/api/auth/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
        { headers: { cookie } },
        e,
      );
      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      expect(location).toContain('/login?error=');
      expect(location).toContain('oidc_token_expired');
    } finally {
      restore();
    }
  });

  it('IdP 直接回跳 error 参数（access_denied）→ 302 /login?error=oidc_provider_error，不透传细节', async () => {
    const restore = installFakeIdp('unused');
    try {
      const e = env();
      const { cookie } = await acquireFlowCookie(e);
      const res = await app.request(
        'https://team.example.com/api/auth/callback?error=access_denied&error_description=user+canceled',
        { headers: { cookie } },
        e,
      );
      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      expect(location).toContain('/login?error=');
      expect(location).toContain('oidc_provider_error');
      expect(location).not.toContain('access_denied');
      expect(location).not.toContain('user+canceled');
    } finally {
      restore();
    }
  });

  it('流程 Cookie 是损坏 JSON → 400（保持现状）', async () => {
    const res = await app.request(
      'https://team.example.com/api/auth/callback?code=abc&state=st',
      { headers: { cookie: 'unself_oidc_flow=%7Bnot-json' } },
      env(),
    );
    expect(res.status).toBe(400);
  });

  it('缺流程 Cookie → 400（保持现状）', async () => {
    const res = await app.request(
      'https://team.example.com/api/auth/callback?code=abc&state=st',
      {},
      env(),
    );
    expect(res.status).toBe(400);
  });
});
