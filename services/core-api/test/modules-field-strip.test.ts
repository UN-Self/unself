// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';

/**
 * S6 安全回归（#208）：/api/modules 匿名可读，其安全性完全依赖注册时
 * ModuleRegistrationSchema → ModuleManifestSchema（z.object 默认 strip 模式）剥掉
 * manifest 里的未知字段。若有人把 schema 改成 passthrough/loose 或让路由存原始 body，
 * 多余字段（如 { evil, admin }）就会随 manifest_json 原样入库并经成员侧端点外泄。
 *
 * 覆盖两条防线（docs/architecture.md 模块注册表）：
 * 1. 存库行 manifest_json 不含未知键（第一现场，路由无关）
 * 2. GET /api/modules 响应条目不含未知键（成员可见面）
 */

const app = createApp();
import { generateInstanceKeyPair } from '../src/keys';
import { createCoreDb, type CoreTestDb } from './test-factory';

const helloManifest = {
  id: 'hello',
  route: '/m/hello',
  entry: 'https://team.example.com/m/hello/',
  runtime: 'worker',
  requires: ['identity'],
  capabilities: ['counter'],
  version: '1.0.0',
  icon: 'inbox',
};

/** 造一个带 admin 会话 Cookie 的环境（注册写端点要 admin；场景同 registry.test.ts）。 */
async function adminEnv(): Promise<{
  env: { JWT_PRIVATE_KEY: string; CORE_DB: D1Database };
  db: CoreTestDb;
  cookie: string;
}> {
  const pair = await generateInstanceKeyPair();
  const { createSessionToken } = await import('../src/session');
  const token = await createSessionToken(
    { uid: 'u_admin', iss: 'https://idp', sub: 'sub-admin', name: 'admin' },
    pair.privateKeyPem,
  );
  const db = createCoreDb();
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)',
    'u_admin',
    'https://idp',
    'sub-admin',
    '管理',
    'admin',
  );
  return {
    env: { JWT_PRIVATE_KEY: pair.privateKeyPem, CORE_DB: db.d1 },
    db,
    cookie: `unself_session=${token}`,
  };
}

function register(
  env: { JWT_PRIVATE_KEY: string; CORE_DB: D1Database },
  cookie: string,
  body: unknown,
) {
  return app.request(
    'https://t.example/api/admin/modules',
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe('S6 /api/modules 字段剥离回归（#208）', () => {
  it('注册 body manifest 带 evil/admin 未知字段 → 存库 manifest_json 不含这些键', async () => {
    const { env, db, cookie } = await adminEnv();
    const poisoned = { ...helloManifest, evil: 'x', admin: true };

    const res = await register(env, cookie, { id: 'hello', enabled: true, manifest: poisoned });
    expect(res.status).toBe(201);

    const row = db.first<{ manifest_json: string }>(
      'SELECT manifest_json FROM module_registry WHERE id = ?',
      'hello',
    );
    expect(row).not.toBeNull();
    const stored = JSON.parse(row!.manifest_json) as Record<string, unknown>;
    expect(stored).not.toHaveProperty('evil');
    expect(stored).not.toHaveProperty('admin');
    // 已知字段原样保留（剥离只针对未知键，不做无差别清洗）
    expect(stored.capabilities).toEqual(['counter']);
  });

  it('注册 body 顶层未知字段 → 同样不入库不外泄', async () => {
    const { env, db, cookie } = await adminEnv();

    const res = await register(env, cookie, { id: 'hello', enabled: true, manifest: helloManifest, evil: 'top', admin: 1 });
    expect(res.status).toBe(201);

    const row = db.first<{ manifest_json: string }>('SELECT manifest_json FROM module_registry WHERE id = ?', 'hello');
    expect(JSON.parse(row!.manifest_json)).not.toHaveProperty('evil');
    expect((await res.json() as Record<string, unknown>)).not.toHaveProperty('evil');
  });

  it('GET /api/modules 匿名响应条目不含未知键（成员可见面）', async () => {
    const { env, cookie } = await adminEnv();
    await register(env, cookie, {
      id: 'hello',
      enabled: true,
      manifest: { ...helloManifest, evil: 'x', admin: true },
    });

    const res = await app.request('https://t.example/api/modules', {}, env);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]!.manifest).not.toHaveProperty('evil');
    expect(list[0]!.manifest).not.toHaveProperty('admin');
    // 响应条目本身也只有契约四键（id/enabled/version/manifest）
    expect(Object.keys(list[0]!).sort()).toEqual(['enabled', 'id', 'manifest', 'version']);
  });
});
