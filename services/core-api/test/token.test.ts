// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { importJWK, jwtVerify } from 'jose';

import app from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { createCoreDb, type CoreTestDb } from './test-factory';

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

const helloManifest = {
  id: 'hello',
  route: '/m/hello',
  entry: 'https://team.example.com/m/hello/',
  runtime: 'worker',
  requires: ['identity'],
  capabilities: ['counter'],
  version: '1.0.0',
};

/** 真库种子：hello 模块行（迁移 0001 真表，manifest_json NOT NULL 真约束）。 */
function seedHello(db: CoreTestDb, enabled: 0 | 1 = 1): void {
  db.run(
    'INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES (?, ?, ?, ?)',
    'hello',
    enabled,
    helloManifest.version,
    JSON.stringify(helloManifest),
  );
}

describe('POST /api/modules/:id/token（模块 token 签发）', () => {
  it('无会话回 401', async () => {
    const env = await envWith();
    const db = createCoreDb();
    const res = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST' },
      { ...env, CORE_DB: db.d1 },
    );
    expect(res.status).toBe(401);
  });

  it('模块不存在回 404', async () => {
    const env = await envWith();
    const cookie = await sessionCookieFor(env.JWT_PRIVATE_KEY);
    const db = createCoreDb();
    const res = await app.request(
      'https://team.example.com/api/modules/ghost/token',
      { method: 'POST', headers: { cookie } },
      { ...env, CORE_DB: db.d1 },
    );
    expect(res.status).toBe(404);
  });

  it('模块停用（enabled=0）回 403 —— token 门禁', async () => {
    const env = await envWith();
    const cookie = await sessionCookieFor(env.JWT_PRIVATE_KEY);
    const db = createCoreDb();
    seedHello(db, 0);
    const res = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie } },
      { ...env, CORE_DB: db.d1 },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'module disabled' });
  });

  it('合法请求签出 ES256 JWT：claims 正确、JWKS 可验、caps 进 payload', async () => {
    const env = await envWith();
    const cookie = await sessionCookieFor(env.JWT_PRIVATE_KEY);
    const db = createCoreDb();
    seedHello(db);
    const res = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie } },
      { ...env, CORE_DB: db.d1 },
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
    // caps 来自真库 manifest_json（不是替身手造行；真库行与响应 claims 必须一致）
    const row = db.first<{ manifest_json: string }>(
      'SELECT manifest_json FROM module_registry WHERE id = ?',
      'hello',
    );
    expect(row).not.toBeNull();
    expect(body.claims.caps).toEqual(JSON.parse(row!.manifest_json).capabilities);
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

  it('已停用模块在启停后（enabled=1）可再取 token —— 同一真库状态翻转', async () => {
    const env = await envWith();
    const cookie = await sessionCookieFor(env.JWT_PRIVATE_KEY);
    const db = createCoreDb();
    seedHello(db, 0); // 同一真库：先 INSERT enabled=0
    const disabled = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie } },
      { ...env, CORE_DB: db.d1 },
    );
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toEqual({ error: 'module disabled' });
    // 真 UPDATE 翻转 enabled（原两个独立 makeDb 是伪状态变化，不验证秒级生效语义）
    const flip = db.run('UPDATE module_registry SET enabled = 1 WHERE id = ?', 'hello');
    expect(flip.changes).toBe(1);
    const enabled = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie } },
      { ...env, CORE_DB: db.d1 },
    );
    expect(enabled.status).toBe(200);
  });

  // --- 守护用例（审核 T1：查询列 ↔ 建表列错位即红） ------------------------

  it('守护：module_registry 行结构 == 迁移建表列（幻影列/漏列即红）', async () => {
    const db = createCoreDb();
    expect(db.columns('module_registry')).toEqual(['id', 'enabled', 'version', 'manifest_json']);
    seedHello(db);

    // 真库全字段行：列集合必须与建表一致（#56 的幻影列会在此暴露）
    const row = db.first<Record<string, unknown>>('SELECT * FROM module_registry WHERE id = ?', 'hello');
    expect(Object.keys(row ?? {}).sort()).toEqual([...db.columns('module_registry')].sort());

    // 路由级：token 门禁 SELECT 引用真列（假 D1 的 .find() 命中即绿，这里 200 才算）
    const env = await envWith();
    const cookie = await sessionCookieFor(env.JWT_PRIVATE_KEY);
    const res = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie } },
      { ...env, CORE_DB: db.d1 },
    );
    expect(res.status).toBe(200);
  });

  it('守护：真 schema 约束生效（manifest_json NOT NULL）', async () => {
    const db = createCoreDb();
    expect(() =>
      db.run('INSERT INTO module_registry (id, enabled) VALUES (?, ?)', 'bad', 1),
    ).toThrow(); // manifest_json NOT NULL：缺列 INSERT 必须抛错
  });
});
