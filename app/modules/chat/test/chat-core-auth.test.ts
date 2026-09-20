// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

import { app, setEnv } from './worker-app';
import { installRoomDo } from './do-stub';
import {
  createChatDb,
  MemoryKv,
  TEST_VARS,
  type ChatTestDb,
  type ChatTestEnv,
} from './chat-test-factory';

/**
 * #217 认证面（真库集成，路由级 app.request）：
 * core 签发形状的模块 JWT（ES256 + RFC7638 kid，签发侧 services/core-api/src/token.ts）经
 * CORE_JWKS_JSON 本地验签（零运行时网络）→ JIT 建档（users + core_identities）→ API 可用。
 * 负例族：无 token/乱串/错签/错 aud/过期 → 401；缺 CORE_JWKS_JSON → 503。
 */

let db: ChatTestDb;
let env: ChatTestEnv;

beforeEach(() => {
  db = createChatDb();
  env = {
    DB: db.d1,
    SESSIONS: new MemoryKv(),
    ...TEST_VARS,
  };
  installRoomDo(env as unknown as Record<string, unknown>);
  setEnv(env);
});

/** 每个用例一把新 ES256 keypair；CORE_JWKS_JSON 注入 env（部署装配期同源形状）。 */
async function mintSetup(): Promise<{
  makeToken: (overrides?: Record<string, unknown>, expOffset?: number) => Promise<string>;
  signWithForeignKey: (payloadOverrides?: Record<string, unknown>) => Promise<string>;
}> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  env.CORE_JWKS_JSON = JSON.stringify({
    keys: [{ ...publicJwk, kid, use: 'sig', alg: 'ES256' }],
  });

  const makeToken = async (
    overrides: Record<string, unknown> = {},
    expOffset?: number,
  ): Promise<string> => {
    const jwt = new SignJWT({
      iss: 'unself-core',
      sub: 'u_1',
      aud: 'chat',
      name: '黄一',
      ...overrides,
    })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuedAt();
    if (expOffset === undefined) {
      jwt.setExpirationTime('10m');
    } else {
      jwt.setExpirationTime(Math.floor(Date.now() / 1000) + expOffset);
    }
    return jwt.sign(pair.privateKey);
  };

  // 另一把 keypair（错签用例）：同 claims、不同签名者。
  const foreign = await generateKeyPair('ES256', { extractable: true });
  const signWithForeignKey = async (overrides: Record<string, unknown> = {}): Promise<string> =>
    new SignJWT({ iss: 'unself-core', sub: 'u_1', aud: 'chat', name: '黄一', ...overrides })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(foreign.privateKey as unknown as CryptoKey);

  return { makeToken, signWithForeignKey };
}

const authHeaders = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

describe('chat 认证面（#217：模块 JWT 验签 + JIT 建档）', () => {
  it('有效 token → /api/me 200，身份来自 token claims 的 JIT 建档', async () => {
    const { makeToken } = await mintSetup();
    const token = await makeToken({ sub: 'u_1', name: '黄一' });

    const res = await app.request('https://chat.example/api/me', { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: number; username: string; displayName: string } };
    expect(body.user.username).toBe('core:u_1');
    expect(body.user.displayName).toBe('黄一');
    expect(Number.isInteger(body.user.id)).toBe(true);
  });

  it('JIT 幂等：同 sub 两次请求 → users 单行、core_identities 单行、同内部 id', async () => {
    const { makeToken } = await mintSetup();
    const token = await makeToken({ sub: 'u_7' });

    const first = await app.request('https://chat.example/api/me', { headers: authHeaders(token) });
    const second = await app.request('https://chat.example/api/users', { headers: authHeaders(token) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const users = db.query<{ id: number; username: string }>(
      'SELECT id, username FROM users WHERE username = ?',
      'core:u_7',
    );
    expect(users).toHaveLength(1);

    const identities = db.query<{ user_id: number }>(
      'SELECT user_id FROM core_identities WHERE issuer = ? AND sub = ?',
      'unself-core',
      'u_7',
    );
    expect(identities).toHaveLength(1);
    expect(identities[0]!.user_id).toBe(users[0]!.id);
    expect(((await first.json()) as { user: { id: number } }).user.id).toBe(users[0]!.id);
  });

  it('不同 sub → 各建一行；claims.name 落 display_name；general 频道自动入席', async () => {
    const { makeToken } = await mintSetup();
    const tokenA = await makeToken({ sub: 'u_a', name: '甲' });
    const tokenB = await makeToken({ sub: 'u_b', name: '乙' });

    await app.request('https://chat.example/api/me', { headers: authHeaders(tokenA) });
    await app.request('https://chat.example/api/me', { headers: authHeaders(tokenB) });

    const rows = db.query<{ username: string; display_name: string }>(
      'SELECT username, display_name FROM users WHERE username LIKE ? ORDER BY username',
      'core:%',
    );
    expect(rows.map((row) => [row.username, row.display_name])).toEqual([
      ['core:u_a', '甲'],
      ['core:u_b', '乙'],
    ]);

    const memberships = db.query<{ username: string }>(
      `SELECT u.username FROM channel_members cm
       JOIN channels c ON c.id = cm.channel_id AND c.name = 'general'
       JOIN users u ON u.id = cm.user_id
       WHERE u.username LIKE 'core:%' ORDER BY u.username`,
    );
    expect(memberships.map((row) => row.username)).toEqual(['core:u_a', 'core:u_b']);
  });

  it('负例族：无 token / 乱串 / 错签 / 错 aud / 过期 → 全部 401 且不回显 jose 细节', async () => {
    const { makeToken, signWithForeignKey } = await mintSetup();

    const cases: Array<[string, Promise<string> | undefined]> = [
      ['no-token', undefined],
      ['garbage', Promise.resolve('not-a-jwt-at-all')],
      ['wrong-signature', signWithForeignKey()],
      ['wrong-aud', makeToken({ aud: 'other-module' })],
      ['expired', makeToken({}, -10)],
    ];

    for (const [name, tokenPromise] of cases) {
      const headers = tokenPromise === undefined ? {} : authHeaders(await tokenPromise);
      const res = await app.request('https://chat.example/api/bootstrap', { headers });
      expect(res.status, name).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error, name).toBe('请先登录');
      expect(body.error, name).not.toMatch(/jose|jwt/i);
    }
  });

  it('缺 CORE_JWKS_JSON → 503 jwks not provisioned（验证面不可用 ≠ 未认证）', async () => {
    const { makeToken } = await mintSetup();
    env.CORE_JWKS_JSON = '';
    const token = await makeToken();

    const res = await app.request('https://chat.example/api/me', { headers: authHeaders(token) });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('jwks not provisioned');
  });

  it('行被停用（is_disabled=1）后原 token → 401 账号已停用（HTTP 停用语义）', async () => {
    const { makeToken } = await mintSetup();
    const token = await makeToken({ sub: 'u_ban' });

    const ok = await app.request('https://chat.example/api/me', { headers: authHeaders(token) });
    expect(ok.status).toBe(200);

    db.run('UPDATE users SET is_disabled = 1 WHERE username = ?', 'core:u_ban');

    const banned = await app.request('https://chat.example/api/bootstrap', { headers: authHeaders(token) });
    expect(banned.status).toBe(401);
    expect(((await banned.json()) as { error: string }).error).toBe('账号已停用');
  });

  it('v1 路径错误形状为 {error:{code,message}}；非 v1 为 {error}（沿用上游映射）', async () => {
    const { signWithForeignKey } = await mintSetup();

    const legacy = await app.request('https://chat.example/api/bootstrap');
    expect(legacy.status).toBe(401);
    expect(((await legacy.json()) as { error: unknown }).error).toBe('请先登录');

    const v1 = await app.request('https://chat.example/api/v1/rooms/public/1/messages', {
      headers: authHeaders(await signWithForeignKey()),
    });
    expect(v1.status).toBe(401);
    expect(((await v1.json()) as { error: { code: string } }).error.code).toBe('authentication_required');
  });
});
