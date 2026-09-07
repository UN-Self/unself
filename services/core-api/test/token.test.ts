// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createRemoteJWKSet, importJWK, jwtVerify } from 'jose';

import app from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';

/** 内存版 D1 stub：覆盖 users / module_registry 两表的最小查询面。 */
function makeDb(rows: { users?: Array<Record<string, unknown>>; registry?: Array<Record<string, unknown>> }) {
  const users = rows.users ?? [];
  const registry = rows.registry ?? [];
  return {
    prepare(sql: string) {
      const chain = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          chain._args = args;
          return chain;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM module_registry')) {
            const row = registry.find((r) => r.id === chain._args[0]);
            return (row as T) ?? null;
          }
          if (sql.includes('FROM users')) {
            const row = users.find((u) => u.issuer === chain._args[0] && u.sub === chain._args[1]);
            return (row as T) ?? null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes('FROM instance_config')) {
            return { results: [] as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          return { success: true };
        },
      };
      return chain;
    },
  } as unknown as D1Database;
}

async function envWith(): Promise<{ JWT_PRIVATE_KEY: string }> {
  const pair = await generateInstanceKeyPair();
  return { JWT_PRIVATE_KEY: pair.privateKeyPem };
}

/** 签一个合法会话 Cookie 值。 */
async function sessionCookieFor(pem: string, uid = 'u_1'): Promise<string> {
  const { createSessionToken } = await import('../src/session');
  const token = await createSessionToken({ uid, iss: 'https://idp', sub: 'u-1', name: '黄一' }, pem);
  return `unself_session=${token}`;
}

const helloRegistryRow = {
  id: 'hello',
  enabled: 1,
  manifest_json: JSON.stringify({
    id: 'hello',
    route: '/m/hello',
    entry: 'https://team.example.com/m/hello/',
    runtime: 'worker',
    requires: ['identity'],
    capabilities: ['counter'],
    version: '1.0.0',
  }),
};

describe('POST /api/modules/:id/token（模块 token 签发）', () => {
  it('无会话回 401', async () => {
    const env = await envWith();
    const res = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST' },
      { ...env, CORE_DB: makeDb({ registry: [helloRegistryRow] }) },
    );
    expect(res.status).toBe(401);
  });

  it('模块不存在回 404', async () => {
    const env = await envWith();
    const cookie = await sessionCookieFor(env.JWT_PRIVATE_KEY);
    const res = await app.request(
      'https://team.example.com/api/modules/ghost/token',
      { method: 'POST', headers: { cookie } },
      { ...env, CORE_DB: makeDb({ registry: [] }) },
    );
    expect(res.status).toBe(404);
  });

  it('模块停用（enabled=0）回 403 —— token 门禁', async () => {
    const env = await envWith();
    const cookie = await sessionCookieFor(env.JWT_PRIVATE_KEY);
    const res = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie } },
      {
        ...env,
        CORE_DB: makeDb({ registry: [{ ...helloRegistryRow, enabled: 0 }] }),
      },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'module disabled' });
  });

  it('合法请求签出 ES256 JWT：claims 正确、JWKS 可验、caps 进 payload', async () => {
    const env = await envWith();
    const cookie = await sessionCookieFor(env.JWT_PRIVATE_KEY);
    const db = makeDb({ registry: [helloRegistryRow] });
    const res = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie } },
      { ...env, CORE_DB: db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      expiresIn: number;
      claims: { iss: string; sub: string; aud: string; caps: string[]; exp: number; iat: number };
    };
    expect(body.expiresIn).toBe(600);
    expect(body.claims.aud).toBe('hello'); // aud = 模块 id，不跨模块重放
    expect(body.claims.sub).toBe('u_1'); // sub = 核心内部用户 id
    expect(body.claims.caps).toEqual(['counter']); // caps 来自 manifest.capabilities
    expect(body.claims.exp - body.claims.iat).toBe(600); // 10 分钟

    // JWT 结构 + kid 头
    const [headerB64] = body.token.split('.');
    const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString('utf8')) as {
      alg: string;
      kid: string;
    };
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBeTruthy();

    // 用本实例 JWKS 验签（模块后端真实路径）
    const jwksRes = await app.request('https://team.example.com/.well-known/jwks.json', {}, env);
    const jwks = (await jwksRes.json()) as { keys: Array<Record<string, unknown>> };
    // 远程 JWKS 在单测网络不可达，退化为直接用 jwks body 导入（验签逻辑同构）
    const { kid, use, alg, ...pub } = jwks.keys[0]!;
    void kid;
    void use;
    void alg;
    const key = await importJWK(pub, 'ES256');
    const verified = await jwtVerify(body.token, key, { audience: 'hello' });
    expect(verified.payload.sub).toBe('u_1');
    expect(verified.payload.caps).toEqual(['counter']);
    expect(verified.protectedHeader.kid).toBe(header.kid);
  });

  it('已停用模块在启停后（enabled=1）可再取 token —— 启停秒级生效语义', async () => {
    const env = await envWith();
    const cookie = await sessionCookieFor(env.JWT_PRIVATE_KEY);
    const disabled = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie } },
      { ...env, CORE_DB: makeDb({ registry: [{ ...helloRegistryRow, enabled: 0 }] }) },
    );
    expect(disabled.status).toBe(403);
    const enabled = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie } },
      { ...env, CORE_DB: makeDb({ registry: [helloRegistryRow] }) },
    );
    expect(enabled.status).toBe(200);
  });
});
