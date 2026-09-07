// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
  buildAuthorizationRequest,
  discover,
  exchangeAuthorizationCode,
  type DiscoveredMetadata,
  type OidcClientConfig,
} from '../src/oidc';

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'unself-dev';
const CLIENT_SECRET = 'unself-dev-secret';
const REDIRECT = 'https://team.example.com/api/auth/callback';

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
};

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

// ---------------------------------------------------------------------------
// discovery / token 交换：拦截 fetch 做假身份源
// ---------------------------------------------------------------------------

let idTokenIssued: string;

function makeIdToken(overrides: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const header = b64({ alg: 'RS256', kid: 'k1' });
  const payload = b64({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'u-123',
    name: '黄一',
    nonce: 'nonce-x',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  });
  return `${header}.${payload}.sig`;
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
  it('合法 callback 完成换 token 并校验 claims', async () => {
    idTokenIssued = makeIdToken({ nonce: 'nonce-ok' });
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
    idTokenIssued = makeIdToken({ nonce: 'wrong' });
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
    idTokenIssued = makeIdToken({ nonce: 'n', iss: 'https://evil.example.com' });
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
    idTokenIssued = makeIdToken({ nonce: 'n', exp: Math.floor(Date.now() / 1000) - 10 });
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
    idTokenIssued = makeIdToken({ nonce: 'n', aud: 'other-client' });
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
