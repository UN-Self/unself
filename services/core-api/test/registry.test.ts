// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import app from '../src/index';
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

/** 造一个带 admin/user 会话 Cookie 的环境；用户行落真 users 表（迁移 0001）。 */
async function envFor(role: 'admin' | 'user'): Promise<{
  env: { JWT_PRIVATE_KEY: string; CORE_DB: D1Database };
  db: CoreTestDb;
  cookie: string;
}> {
  const pair = await generateInstanceKeyPair();
  const { createSessionToken } = await import('../src/session');
  const token = await createSessionToken(
    { uid: `u_${role}`, iss: 'https://idp', sub: `sub-${role}`, name: role },
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
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)',
    'u_user',
    'https://idp',
    'sub-user',
    '成员',
    'user',
  );
  return {
    env: { JWT_PRIVATE_KEY: pair.privateKeyPem, CORE_DB: db.d1 },
    db,
    cookie: `unself_session=${token}`,
  };
}

const REG_URL = 'https://t.example/api/admin/modules';

function register(
  env: { JWT_PRIVATE_KEY: string; CORE_DB: D1Database },
  cookie: string,
  body: unknown,
) {
  return app.request(
    REG_URL,
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe('registry CRUD 与启停语义（#7）', () => {
  it('注册模块：写入 manifest 快照，201 返回条目', async () => {
    const { env, db, cookie } = await envFor('admin');
    const res = await register(env, cookie, { id: 'hello', enabled: true, manifest: helloManifest });
    expect(res.status).toBe(201);
    const entry = (await res.json()) as { id: string; enabled: boolean; version: string };
    expect(entry.id).toBe('hello');
    expect(entry.enabled).toBe(true);
    expect(entry.version).toBe('1.0.0');

    // 断言真库行（不是替身内部 Map）
    const row = db.first<{ id: string; enabled: number; version: string; manifest_json: string }>(
      'SELECT id, enabled, version, manifest_json FROM module_registry WHERE id = ?',
      'hello',
    );
    expect(row).toEqual({
      id: 'hello',
      enabled: 1,
      version: '1.0.0',
      manifest_json: expect.any(String),
    });
    expect(JSON.parse(row!.manifest_json).capabilities).toEqual(['counter']);
  });

  it('重复注册 upsert：刷新快照不炸（deploy 脚本幂等重跑）', async () => {
    const { env, cookie } = await envFor('admin');
    expect((await register(env, cookie, { id: 'hello', enabled: true, manifest: helloManifest })).status).toBe(201);
    const v2 = { ...helloManifest, version: '1.0.1' };
    const again = await register(env, cookie, { id: 'hello', enabled: true, manifest: v2 });
    expect(again.status).toBe(201);
    const list = (await (await app.request(REG_URL, { headers: { cookie } }, env)).json()) as Array<{
      version: string;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.version).toBe('1.0.1');
  });

  it('enabled 翻转生效；不存在的模块 404', async () => {
    const { env, db, cookie } = await envFor('admin');
    await register(env, cookie, { id: 'hello', manifest: helloManifest });
    const off = await app.request(
      `${REG_URL}/hello/enabled`,
      { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: '{"enabled":false}' },
      env,
    );
    expect(off.status).toBe(200);
    expect(db.first<{ enabled: number }>('SELECT enabled FROM module_registry WHERE id = ?', 'hello')).toEqual({
      enabled: 0,
    });
    const on = await app.request(
      `${REG_URL}/hello/enabled`,
      { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: '{"enabled":true}' },
      env,
    );
    expect(await on.json()).toEqual({ id: 'hello', enabled: true });
    const ghost = await app.request(
      `${REG_URL}/ghost/enabled`,
      { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: '{"enabled":true}' },
      env,
    );
    expect(ghost.status).toBe(404);
  });

  it('成员视角 GET /api/modules 只回 enabled；管理端回全量', async () => {
    const { env, cookie } = await envFor('admin');
    await register(env, cookie, { id: 'hello', enabled: true, manifest: { ...helloManifest, id: 'hello' } });
    await register(env, cookie, { id: 'chat', enabled: false, manifest: { ...helloManifest, id: 'chat' } });
    const adminList = (await (await app.request(REG_URL, { headers: { cookie } }, env)).json()) as Array<{
      id: string;
    }>;
    expect(adminList.map((m) => m.id).sort()).toEqual(['chat', 'hello']);
    const memberList = (await (await app.request('https://t.example/api/modules', {}, env)).json()) as Array<{
      id: string;
    }>;
    expect(memberList.map((m) => m.id)).toEqual(['hello']);
  });

  it('非管理员被拒：无会话 401、普通成员 403、坏 body 400', async () => {
    const { env, cookie } = await envFor('user');
    const anon = await app.request(REG_URL, { method: 'POST' }, env);
    expect(anon.status).toBe(401);
    const member = await register(env, cookie, { id: 'hello', manifest: helloManifest });
    expect(member.status).toBe(403);
    const adminEnv = await envFor('admin');
    const badBody = await register(adminEnv.env, adminEnv.cookie, { id: 'HELLO', manifest: {} });
    expect(badBody.status).toBe(400);
    const badToggle = await app.request(
      `${REG_URL}/hello/enabled`,
      { method: 'PATCH', headers: { cookie: adminEnv.cookie, 'content-type': 'application/json' }, body: '{"enabled":"yes"}' },
      adminEnv.env,
    );
    expect(badToggle.status).toBe(400);
  });

  it('启停动作写入审计（真 audit_log 表）', async () => {
    const { env, db, cookie } = await envFor('admin');
    await register(env, cookie, { id: 'hello', manifest: helloManifest });
    await app.request(
      `${REG_URL}/hello/enabled`,
      { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: '{"enabled":false}' },
      env,
    );
    const actions = db.query<{ action: string; target: string | null }>(
      'SELECT action, target FROM audit_log ORDER BY id',
    );
    expect(actions).toContainEqual({ action: 'module_upserted', target: 'hello' });
    expect(actions).toContainEqual({ action: 'module_disabled', target: 'hello' });
  });

  // --- 守护用例（审核 T1：查询列 ↔ 建表列错位即红） ------------------------

  it('守护：module_registry 行结构 == 迁移建表列（幻影列/漏列即红）', async () => {
    const { env, db, cookie } = await envFor('admin');
    expect(db.columns('module_registry')).toEqual(['id', 'enabled', 'version', 'manifest_json']);
    await register(env, cookie, { id: 'hello', manifest: helloManifest });

    // 真库全字段行：列集合必须与建表一致（历史幻影列会在此暴露）
    const row = db.first<Record<string, unknown>>('SELECT * FROM module_registry WHERE id = ?', 'hello');
    expect(Object.keys(row ?? {}).sort()).toEqual([...db.columns('module_registry')].sort());

    // 路由级：源码 SELECT 一旦引用不存在的列，这里就是 500（而非假 D1 的静默绿）
    const list = await app.request(REG_URL, { headers: { cookie } }, env);
    expect(list.status).toBe(200);
    const entries = (await list.json()) as Array<Record<string, unknown>>;
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual([
      'enabled',
      'id',
      'manifest',
      'version',
    ]);
  });

  it('守护：真 schema 约束生效（users UNIQUE(issuer,sub)、module_registry NOT NULL）', async () => {
    const { db } = await envFor('admin');
    expect(() =>
      db.run(
        'INSERT INTO users (id, issuer, sub, role) VALUES (?, ?, ?, ?)',
        'u_dup',
        'https://idp',
        'sub-admin',
        'user',
      ),
    ).toThrow(); // 同一 issuer+sub 二次建档必须违反 UNIQUE
    expect(() => db.run('INSERT INTO module_registry (id, enabled) VALUES (?, ?)', 'bad', 1)).toThrow(); // manifest_json NOT NULL
  });
});

describe('模块启停写端点 POST /toggle（#49）', () => {
  function toggle(
    env: { JWT_PRIVATE_KEY: string; CORE_DB: D1Database },
    cookie: string,
    id: string,
    body: unknown,
  ) {
    return app.request(
      `${REG_URL}/${id}/toggle`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      env,
    );
  }

  it('POST /toggle 翻转 enabled 并留痕（真库行 + 真 audit_log）', async () => {
    const { env, db, cookie } = await envFor('admin');
    await register(env, cookie, { id: 'hello', enabled: true, manifest: helloManifest });

    const off = await toggle(env, cookie, 'hello', { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ id: 'hello', enabled: false });
    expect(db.first<{ enabled: number }>('SELECT enabled FROM module_registry WHERE id = ?', 'hello')).toEqual({
      enabled: 0,
    });

    const on = await toggle(env, cookie, 'hello', { enabled: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ id: 'hello', enabled: true });
    expect(db.first<{ enabled: number }>('SELECT enabled FROM module_registry WHERE id = ?', 'hello')).toEqual({
      enabled: 1,
    });

    expect(db.query('SELECT actor, action, target FROM audit_log ORDER BY id')).toEqual([
      { actor: 'u_admin', action: 'module_upserted', target: 'hello' },
      { actor: 'u_admin', action: 'module_disabled', target: 'hello' },
      { actor: 'u_admin', action: 'module_enabled', target: 'hello' },
    ]);
  });

  it('不存在的模块 404 且不写审计（失败不伪造留痕）', async () => {
    const { env, db, cookie } = await envFor('admin');
    const res = await toggle(env, cookie, 'ghost', { enabled: false });
    expect(res.status).toBe(404);
    expect(db.query('SELECT id FROM audit_log')).toEqual([]);
  });

  it('坏 body 400 且状态不变（缺字段/非布尔/非 JSON 三态）', async () => {
    const { env, db, cookie } = await envFor('admin');
    await register(env, cookie, { id: 'hello', enabled: true, manifest: helloManifest });
    for (const body of ['{}', '{"enabled":"yes"}', 'not json']) {
      expect((await toggle(env, cookie, 'hello', body)).status).toBe(400);
    }
    expect(db.first<{ enabled: number }>('SELECT enabled FROM module_registry WHERE id = ?', 'hello')).toEqual({
      enabled: 1,
    });
  });

  it('授权沿用管理守卫：无会话 401、普通成员 403（模块状态与审计均不受影响）', async () => {
    const { env, db, cookie } = await envFor('user');
    db.run(
      "INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES ('hello', 1, '1.0.0', '{}')",
    );

    const anon = await app.request(
      `${REG_URL}/hello/toggle`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' },
      env,
    );
    expect(anon.status).toBe(401);

    expect((await toggle(env, cookie, 'hello', { enabled: false })).status).toBe(403);
    expect(db.first<{ enabled: number }>('SELECT enabled FROM module_registry WHERE id = ?', 'hello')).toEqual({
      enabled: 1,
    });
    expect(db.query('SELECT id FROM audit_log')).toEqual([]);
  });
});
