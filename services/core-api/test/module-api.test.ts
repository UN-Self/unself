// SPDX-License-Identifier: AGPL-3.0-only
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { getSigningRuntime } from '../src/keys';
import { MODULE_TOKEN_ISSUER, issueModuleToken } from '../src/token';
import { applyMigrations, createCoreDb, createD1Adapter, type CoreTestDb } from './test-factory';

/**
 * /api/module-api/* 权限门禁（#243 验收③，决策 #56）：
 * 「permissions 未声明即调用对应 Core API → 403」必须在真路由上可复现——
 * 门禁真值 = 注册表 manifest 快照（服务端），token 不携带能力清单（caps 已删）。
 * MODULES_DB 用真 SQLite 加载 app/modules/hello 真迁移（module_kv），不是替身。
 */

const app = createApp();

/** manifest v1 夹具：按用例需要给 permissions。 */
const manifestV1 = (permissions?: string[]) => ({
  id: 'hello',
  route: '/m/hello',
  entry: 'https://team.example.com/m/hello/',
  runtimes: ['worker'],
  version: '1.0.0',
  ...(permissions ? { permissions } : {}),
});

function seedModule(db: CoreTestDb, permissions?: string[], enabled: 0 | 1 = 1): void {
  const manifest = manifestV1(permissions);
  db.run(
    'INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES (?, ?, ?, ?)',
    manifest.id,
    enabled,
    manifest.version,
    JSON.stringify(manifest),
  );
}

/** modules 库（module_kv 真建表）——storage API 的数据落点。
 * #248：承载表是**平台基建**（services/core-api/migrations/modules/），不再由 hello 模块自带迁移创建；
 * 测试与装配器同源加载同一份平台迁移文件（同一份 SQL，不做替身）。 */
function createModulesDb(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(
    sqlite,
    fileURLToPath(new URL('../migrations/modules/', import.meta.url)),
  );
  return createD1Adapter(sqlite);
}

async function envWith(): Promise<{ JWT_PRIVATE_KEY: string; MODULES_DB: D1Database }> {
  const pair = await generateInstanceKeyPair();
  return { JWT_PRIVATE_KEY: pair.privateKeyPem, MODULES_DB: createModulesDb() };
}

/** 用实例私钥签一个模块 token（与 core 签发端点同一条 issueModuleToken 路径）。 */
async function moduleTokenFor(pem: string, moduleId = 'hello'): Promise<string> {
  const runtime = await getSigningRuntime(pem);
  const issued = await issueModuleToken(
    runtime!,
    { userId: 'u_1', moduleId },
    { issuer: MODULE_TOKEN_ISSUER },
  );
  return issued.token;
}

const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

describe('POST/GET /api/module-api/*（模块 Core API 门禁）', () => {
  it('无 token → 401；伪造 token → 401（验签不过不区分原因）', async () => {
    const env = await envWith();
    const db = createCoreDb();
    seedModule(db, ['storage']);

    const noAuth = await app.request(
      'https://team.example.com/api/module-api/storage/count',
      {},
      { ...env, CORE_DB: db.d1 },
    );
    expect(noAuth.status).toBe(401);

    const badAuth = await app.request(
      'https://team.example.com/api/module-api/storage/count',
      { headers: { authorization: 'Bearer not-a-jwt' } },
      { ...env, CORE_DB: db.d1 },
    );
    expect(badAuth.status).toBe(401);
  });

  it('声明 storage：put → get → list 往返 200，数据真落 module_kv（module_id=hello 子域）', async () => {
    const env = await envWith();
    const db = createCoreDb();
    seedModule(db, ['storage']);
    const token = await moduleTokenFor(env.JWT_PRIVATE_KEY);

    const put = await app.request(
      'https://team.example.com/api/module-api/storage/count',
      { method: 'PUT', headers: { ...authHeader(token), 'content-type': 'application/json' }, body: JSON.stringify({ value: '3' }) },
      { ...env, CORE_DB: db.d1 },
    );
    expect(put.status).toBe(200);

    const get = await app.request(
      'https://team.example.com/api/module-api/storage/count',
      { headers: authHeader(token) },
      { ...env, CORE_DB: db.d1 },
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ key: 'count', value: '3' });

    // 数据真在 modules 库的 module_kv 行里（不是路由层假象）
    const stored = await env.MODULES_DB.prepare(
      'SELECT module_id, key, value FROM module_kv WHERE module_id = ? AND key = ?',
    )
      .bind('hello', 'count')
      .first<{ module_id: string; key: string; value: string }>();
    expect(stored).toEqual({ module_id: 'hello', key: 'count', value: '3' });
  });

  it('验收③：未声明 storage（permissions 省略）→ 403，错误面点名缺失的权限词', async () => {
    const env = await envWith();
    const db = createCoreDb();
    seedModule(db); // 无 permissions 字段
    const token = await moduleTokenFor(env.JWT_PRIVATE_KEY);

    const res = await app.request(
      'https://team.example.com/api/module-api/storage/count',
      { headers: authHeader(token) },
      { ...env, CORE_DB: db.d1 },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "module 'hello' lacks required permission 'storage'",
    });
  });

  it('未声明 notify → 403；声明 notify → 201 且站内通知真落库（module_notify）', async () => {
    const env = await envWith();
    const db = createCoreDb();
    db.run(
      "INSERT INTO users (id, issuer, sub, display_name) VALUES ('u_9', 'https://idp', 'u-9', '收件人')",
    );
    const token = await moduleTokenFor(env.JWT_PRIVATE_KEY);
    const body = JSON.stringify({ userId: 'u_9', title: '有人 @ 你', body: 'hello 提醒' });

    // 未声明（只有 storage）→ 403
    seedModule(db, ['storage']);
    const denied = await app.request(
      'https://team.example.com/api/module-api/notify',
      { method: 'POST', headers: { ...authHeader(token), 'content-type': 'application/json' }, body },
      { ...env, CORE_DB: db.d1 },
    );
    expect(denied.status).toBe(403);
    expect(db.query("SELECT * FROM notifications WHERE type = 'module_notify'")).toHaveLength(0);

    // 声明 notify → 201 + notifications 真行
    db.run("DELETE FROM module_registry WHERE id = 'hello'");
    seedModule(db, ['storage', 'notify']);
    const ok = await app.request(
      'https://team.example.com/api/module-api/notify',
      { method: 'POST', headers: { ...authHeader(token), 'content-type': 'application/json' }, body },
      { ...env, CORE_DB: db.d1 },
    );
    expect(ok.status).toBe(201);
    const rows = db.query<{ type: string; user_id: string }>(
      "SELECT type, user_id FROM notifications WHERE type = 'module_notify'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe('u_9');
  });

  it('预留词：声明 ai → 门禁过但端点 501（不静默假成功）；未声明 acl → 403（门禁先于 501）', async () => {
    const env = await envWith();
    const db = createCoreDb();
    seedModule(db, ['storage', 'ai']);
    const token = await moduleTokenFor(env.JWT_PRIVATE_KEY);

    const ai = await app.request(
      'https://team.example.com/api/module-api/ai/complete',
      { method: 'POST', headers: authHeader(token) },
      { ...env, CORE_DB: db.d1 },
    );
    expect(ai.status).toBe(501);

    const acl = await app.request(
      'https://team.example.com/api/module-api/acl/entries',
      { headers: authHeader(token) },
      { ...env, CORE_DB: db.d1 },
    );
    expect(acl.status).toBe(403);
  });

  it('模块停用（enabled=0）→ 403 module disabled（注册表开关同样管住模块面）', async () => {
    const env = await envWith();
    const db = createCoreDb();
    seedModule(db, ['storage'], 0);
    const token = await moduleTokenFor(env.JWT_PRIVATE_KEY);

    const res = await app.request(
      'https://team.example.com/api/module-api/storage/count',
      { headers: authHeader(token) },
      { ...env, CORE_DB: db.d1 },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'module disabled' });
  });

  it('子域隔离：hello 的 token 读不到 chat 子域的键（module_id 恒取 token aud）', async () => {
    const env = await envWith();
    const db = createCoreDb();
    seedModule(db, ['storage']);
    await env.MODULES_DB.prepare(
      'INSERT INTO module_kv (module_id, key, value) VALUES (?, ?, ?)',
    )
      .bind('chat', 'secret', 'x')
      .run();
    const token = await moduleTokenFor(env.JWT_PRIVATE_KEY, 'hello');

    const res = await app.request(
      'https://team.example.com/api/module-api/storage/secret',
      { headers: authHeader(token) },
      { ...env, CORE_DB: db.d1 },
    );
    expect(res.status).toBe(404);
  });
});
