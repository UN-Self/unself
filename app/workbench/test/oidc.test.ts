// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, beforeEach, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

import {
  buildAuthorizationRequest,
  discover,
  exchangeAuthorizationCode,
  pickScope,
  resetOidcCaches,
  type DiscoveredMetadata,
  type OidcClientConfig,
} from '../src/oidc';

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'unself-dev';
const CLIENT_SECRET = 'unself-dev-secret';
const REDIRECT = 'https://team.example.com/api/auth/callback';
const JWKS_URI = `${ISSUER}/jwks`;

const config: OidcClientConfig = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  scope: 'openid profile email',
  redirectUri: REDIRECT,
};

const metadata: DiscoveredMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: JWKS_URI,
};

// 真 RS256 密钥：JWKS 公开签名密钥 + 签发侧私钥（id_token 验签不再用伪签名）
let signingPrivateKey: CryptoKey;
let signingJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  signingPrivateKey = pair.privateKey;
  signingJwk = await exportJWK(pair.publicKey);
});

beforeEach(() => {
  // 清空发现文档 + JWKS 集合缓存（键按 issuer 存，跨测试防串）
  resetOidcCaches();
});

describe('buildAuthorizationRequest（授权码 + PKCE S256）', () => {
  it('生成含全部必要参数的授权 URL', async () => {
    const req = await buildAuthorizationRequest(config, metadata);
    const url = new URL(req.authorizeUrl);
    expect(url.origin + url.pathname).toBe(metadata.authorization_endpoint);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // state/nonce/code_challenge 均存在且互不相同
    const state = url.searchParams.get('state');
    const nonce = url.searchParams.get('nonce');
    const challenge = url.searchParams.get('code_challenge');
    expect(state).toBeTruthy();
    expect(nonce).toBeTruthy();
    expect(challenge).toBeTruthy();
    expect(state).not.toBe(nonce);
    expect(req.state).toBe(state);
    expect(req.nonce).toBe(nonce);
    expect(req.codeVerifier).not.toBe(challenge);
  });

  it('code_challenge = BASE64URL(SHA256(code_verifier))（RFC 7636）', async () => {
    const req = await buildAuthorizationRequest(config, metadata);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(req.codeVerifier));
    const bin = String.fromCharCode(...new Uint8Array(digest));
    const expected = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = new URL(req.authorizeUrl);
    expect(url.searchParams.get('code_challenge')).toBe(expected);
  });

  it('每次生成独立参数', async () => {
    const a = await buildAuthorizationRequest(config, metadata);
    const b = await buildAuthorizationRequest(config, metadata);
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe('pickScope（#55：#55 scope 按 discovery scopes_supported 过滤）', () => {
  const three = 'openid profile email';

  it('交集 = [openid,profile,email] ∩ scopes_supported，顺序固定', () => {
    expect(pickScope(three, { ...metadata, scopes_supported: ['email', 'profile', 'openid'] })).toBe(three);
    expect(pickScope(three, { ...metadata, scopes_supported: ['openid', 'offline_access', 'mail', 'contacts', 'calendars'] })).toBe('openid');
    expect(pickScope(three, { ...metadata, scopes_supported: ['profile'] })).toBe('profile');
  });

  it('交集空只发 openid（PKCE 登录最低要求）', () => {
    expect(pickScope(three, { ...metadata, scopes_supported: ['offline_access', 'mail'] })).toBe('openid');
  });

  it('scopes_supported 字段缺失维持三件', () => {
    expect(pickScope(three, metadata)).toBe(three);
  });

  it('尊重已配置 scope（配置里没请求的项不发）', () => {
    expect(pickScope('openid', { ...metadata, scopes_supported: ['openid', 'profile', 'email'] })).toBe('openid');
  });
});

// ---------------------------------------------------------------------------
// discovery / token 交换：拦截 fetch 做假身份源
// ---------------------------------------------------------------------------

let idTokenIssued: string;

/** 用真实 RS256 签名签发 id_token（替代伪签名 '.sig'）。 */
async function makeIdToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'u-123',
    name: '黄一',
    nonce: 'nonce-x',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .sign(signingPrivateKey);
}

function fakeJwksBody(): string {
  return JSON.stringify({ keys: [{ ...signingJwk, kid: 'k1', alg: 'RS256', use: 'sig' }] });
}

function installFakeIdp(metadataOverride: Partial<DiscoveredMetadata> = {}) {
  const originalFetch = globalThis.fetch;
  const tokenRequests: Array<{ url: string; body: URLSearchParams }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/.well-known/openid-configuration')) {
      return new Response(
        JSON.stringify({ ...metadata, scopes_supported: ['openid'], ...metadataOverride }),
        { status: 200 },
      );
    }
    if (url === JWKS_URI) {
      return new Response(fakeJwksBody(), { status: 200 });
    }
    if (url === metadata.token_endpoint) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      tokenRequests.push({ url, body });
      return new Response(
        JSON.stringify({
          access_token: 'at-1',
          token_type: 'Bearer',
          id_token: idTokenIssued,
        }),
        { status: 200 },
      );
    }
    throw new Error(`fake idp: unexpected fetch ${url}`);
  }) as typeof fetch;
  return {
    tokenRequests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe('discover', () => {
  it('拉取并校验发现文档', async () => {
    const fake = installFakeIdp();
    try {
      const meta = await discover(ISSUER);
      expect(meta.authorization_endpoint).toBe(`${ISSUER}/authorize`);
      expect(meta.token_endpoint).toBe(`${ISSUER}/token`);
    } finally {
      fake.restore();
    }
  });

  it('issuer 不匹配时拒绝', async () => {
    const fake = installFakeIdp({ issuer: 'https://other.example.com' });
    try {
      // 先清缓存：discover 以 issuer 为键缓存
      await expect(discover('https://evil.example.com')).rejects.toThrow();
    } finally {
      fake.restore();
    }
  });
});

describe('exchangeAuthorizationCode（callback：state/PKCE/nonce 校验 + 换 token）', () => {
  it('合法 callback 完成换 token 并校验 claims（真 RS256 验签）', async () => {
    idTokenIssued = await makeIdToken({ nonce: 'nonce-ok' });
    const fake = installFakeIdp();
    try {
      const result = await exchangeAuthorizationCode(
        config,
        metadata,
        `${REDIRECT}?code=abc&state=state-ok`,
        { state: 'state-ok', nonce: 'nonce-ok', codeVerifier: 'verifier-ok' },
      );
      expect(result.claims.sub).toBe('u-123');
      expect(result.idToken).toBe(idTokenIssued);
      // token 请求带 PKCE code_verifier 与 client 凭证
      const body = fake.tokenRequests[0]?.body;
      expect(body?.get('grant_type')).toBe('authorization_code');
      expect(body?.get('code')).toBe('abc');
      expect(body?.get('code_verifier')).toBe('verifier-ok');
      expect(body?.get('client_id')).toBe(CLIENT_ID);
      expect(body?.get('client_secret')).toBe(CLIENT_SECRET);
      expect(body?.get('redirect_uri')).toBe(REDIRECT);
    } finally {
      fake.restore();
    }
  });

  it('坏签名拒绝：JWKS 上的公钥与签名私钥不匹配', async () => {
    const attacker = await generateKeyPair('RS256', { extractable: true });
    idTokenIssued = await new SignJWT({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'u-evil',
      nonce: 'n',
      exp: Math.floor(Date.now() / 1000) + 600,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .sign(attacker.privateKey);
    const fake = installFakeIdp();
    try {
      await expect(
        exchangeAuthorizationCode(config, metadata, `${REDIRECT}?code=abc&state=s`, {
          state: 's',
          nonce: 'n',
          codeVerifier: 'v',
        }),
      ).rejects.toThrow(/signature verification failed/);
    } finally {
      fake.restore();
    }
  });

  it('元数据缺 jwks_uri 时拒绝（fail-closed）', async () => {
    idTokenIssued = await makeIdToken({ nonce: 'n' });
    const fake = installFakeIdp();
    try {
      const { jwks_uri: _omit, ...noJwks } = metadata;
      await expect(
        exchangeAuthorizationCode(config, noJwks, `${REDIRECT}?code=abc&state=s`, {
          state: 's',
          nonce: 'n',
          codeVerifier: 'v',
        }),
      ).rejects.toThrow(/jwks_uri/);
    } finally {
      fake.restore();
    }
  });

  it('JWKS 拉取失败时拒绝登录（fail-closed）', async () => {
    idTokenIssued = await makeIdToken({ nonce: 'n' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === JWKS_URI) {
        return new Response('server error', { status: 500 });
      }
      if (url.includes('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({ ...metadata, scopes_supported: ['openid'] }),
          { status: 200 },
        );
      }
      if (url === metadata.token_endpoint) {
        return new Response(
          JSON.stringify({ access_token: 'at-1', token_type: 'Bearer', id_token: idTokenIssued }),
          { status: 200 },
        );
      }
      throw new Error(`fake idp: unexpected fetch ${url}`);
    }) as typeof fetch;
    try {
      await expect(
        exchangeAuthorizationCode(config, metadata, `${REDIRECT}?code=abc&state=s`, {
          state: 's',
          nonce: 'n',
          codeVerifier: 'v',
        }),
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('state 不匹配拒绝（CSRF）', async () => {
    const fake = installFakeIdp();
    try {
      await expect(
        exchangeAuthorizationCode(config, metadata, `${REDIRECT}?code=abc&state=bad`, {
          state: 'state-ok',
          nonce: 'n',
          codeVerifier: 'v',
        }),
      ).rejects.toThrow(/state mismatch/);
    } finally {
      fake.restore();
    }
  });

  it('provider 返回 error 时透传', async () => {
    const fake = installFakeIdp();
    try {
      await expect(
        exchangeAuthorizationCode(config, metadata, `${REDIRECT}?error=access_denied`, {
          state: 's',
          nonce: 'n',
          codeVerifier: 'v',
        }),
      ).rejects.toThrow(/access_denied/);
    } finally {
      fake.restore();
    }
  });

  it('id_token nonce 不匹配拒绝', async () => {
    idTokenIssued = await makeIdToken({ nonce: 'wrong' });
    const fake = installFakeIdp();
    try {
      await expect(
        exchangeAuthorizationCode(config, metadata, `${REDIRECT}?code=abc&state=s`, {
          state: 's',
          nonce: 'n',
          codeVerifier: 'v',
        }),
      ).rejects.toThrow(/nonce mismatch/);
    } finally {
      fake.restore();
    }
  });

  it('id_token iss 不匹配拒绝', async () => {
    idTokenIssued = await makeIdToken({ nonce: 'n', iss: 'https://evil.example.com' });
    const fake = installFakeIdp();
    try {
      await expect(
        exchangeAuthorizationCode(config, metadata, `${REDIRECT}?code=abc&state=s`, {
          state: 's',
          nonce: 'n',
          codeVerifier: 'v',
        }),
      ).rejects.toThrow(/iss mismatch/);
    } finally {
      fake.restore();
    }
  });

  it('id_token 过期拒绝', async () => {
    idTokenIssued = await makeIdToken({ nonce: 'n', exp: Math.floor(Date.now() / 1000) - 10 });
    const fake = installFakeIdp();
    try {
      await expect(
        exchangeAuthorizationCode(config, metadata, `${REDIRECT}?code=abc&state=s`, {
          state: 's',
          nonce: 'n',
          codeVerifier: 'v',
        }),
      ).rejects.toThrow(/expired/);
    } finally {
      fake.restore();
    }
  });

  it('id_token aud 不匹配拒绝', async () => {
    idTokenIssued = await makeIdToken({ nonce: 'n', aud: 'other-client' });
    const fake = installFakeIdp();
    try {
      await expect(
        exchangeAuthorizationCode(config, metadata, `${REDIRECT}?code=abc&state=s`, {
          state: 's',
          nonce: 'n',
          codeVerifier: 'v',
        }),
      ).rejects.toThrow(/aud mismatch/);
    } finally {
      fake.restore();
    }
  });
});
