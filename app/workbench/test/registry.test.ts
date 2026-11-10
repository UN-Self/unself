// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';

const app = createApp();
import { generateInstanceKeyPair } from '../src/keys';
import { createCoreDb, type CoreTestDb } from './test-factory';

const helloManifest = {
  id: 'hello',
  route: '/m/hello',
  entry: 'https://team.example.com/m/hello/',
  runtimes: ['worker'],
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
  it('落点三列合并语义（#348 review 定案）：未写保留旧值，201 回合并后真行；mode 显式给出才核对 connect/entry', async () => {
    const { env, cookie } = await envFor('admin');
    // 首次注册：显式写三列（管理接口路径的用户选择）
    const first = await register(env, cookie, {
      id: 'hello',
      enabled: true,
      manifest: helloManifest,
      mode: 'connect',
      entry: 'https://bridge.example.com/m/bridge/',
      storage_level: 'dedicated',
      credential_hash: 'a'.repeat(64),
    });
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({
      mode: 'connect',
      entry: 'https://bridge.example.com/m/bridge/',
      storage_level: 'dedicated',
      credential_hash: 'a'.repeat(64),
    });
    // 重新注册（装配路径：只刷新快照，落点/凭证四列全未写）→ 旧值保留；响应是 RETURNING 真行，不回显请求值
    const second = await register(env, cookie, { id: 'hello', enabled: true, manifest: helloManifest });
    expect(second.status).toBe(201);
    await expect(second.json()).resolves.toMatchObject({
      mode: 'connect',
      entry: 'https://bridge.example.com/m/bridge/',
      storage_level: 'dedicated',
      credential_hash: 'a'.repeat(64),
    });
    // mode 显式给出而 entry 缺失 → 400（不变式照旧）；mode 未写则不参与核对（列中旧值入库时已过 CHECK）
    const bad = await register(env, cookie, { id: 'other', enabled: true, manifest: helloManifest, mode: 'connect' });
    expect(bad.status).toBe(400);
  });

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
    expect(JSON.parse(row!.manifest_json)).toMatchObject({ id: 'hello', version: '1.0.0' });
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

  it('成员视角 GET /api/modules 只回 enabled，且不回落点/凭证（#348 遗留收窄，#349）', async () => {
    const { env, cookie } = await envFor('admin');
    await register(env, cookie, {
      id: 'hello',
      enabled: true,
      manifest: { ...helloManifest, description: '信箱' },
      mode: 'connect',
      entry: 'https://bridge.example.com/m/bridge/',
      credential_hash: 'a'.repeat(64),
    });
    await register(env, cookie, { id: 'chat', enabled: false, manifest: { ...helloManifest, id: 'chat' } });
    const adminList = (await (await app.request(REG_URL, { headers: { cookie } }, env)).json()) as Array<{
      id: string;
    }>;
    expect(adminList.map((m) => m.id).sort()).toEqual(['chat', 'hello']);
    const memberList = (await (await app.request('https://t.example/api/modules', {}, env)).json()) as Array<
      Record<string, unknown>
    >;
    // 只回 enabled 行
    expect(memberList.map((m) => m.id)).toEqual(['hello']);
    // 收窄面：id/enabled/name/manifest（壳 iframe 与 nav 图标的数据源），敏感面一个不外泄
    expect(Object.keys(memberList[0]!).sort()).toEqual(['enabled', 'id', 'manifest', 'name']);
    expect(memberList[0]).toMatchObject({ enabled: true, name: '信箱' });
    expect(memberList[0]!.manifest).toMatchObject({ id: 'hello', icon: 'inbox' });
    const serialized = JSON.stringify(memberList);
    // registry 落点三列与凭证哈希不出现在成员面（独立域 URL 与 64 位 hex 均不外泄）
    expect(serialized).not.toContain('bridge.example.com');
    expect(serialized).not.toContain('a'.repeat(64));
    expect(serialized).not.toContain('"mode"');
    expect(serialized).not.toContain('"storage_level"');
    expect(serialized).not.toContain('"credential_hash"');
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

  it('落点三列（#348）：透传 + 缺省 + CHECK 不变式人话 400', async () => {
    const { env, db, cookie } = await envFor('admin');

    // 透传：mode/entry/storage_level 原样落库并回显
    const created = await register(env, cookie, {
      id: 'hello',
      manifest: helloManifest,
      mode: 'connect',
      entry: 'https://self.example.com/hello/',
      storage_level: 'dedicated',
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      mode: 'connect',
      entry: 'https://self.example.com/hello/',
      storage_level: 'dedicated',
    });

    // 缺省：不带落点字段 → mode=cloudflare，entry/storage_level 均空
    await register(env, cookie, { id: 'plain', manifest: helloManifest });
    const plain = db.first<Record<string, unknown>>("SELECT mode, entry, storage_level FROM module_registry WHERE id = 'plain'");
    expect(plain).toEqual({ mode: 'cloudflare', entry: null, storage_level: null });

    // 反面：connect 而 entry 为空 → 400 人话（与 0012 CHECK 同一规则）
    const bad = await register(env, cookie, { id: 'bad', manifest: helloManifest, mode: 'connect' });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: string; detail?: string };
    expect(badBody.detail ?? badBody.error).toContain('entry');

    // 反面：非法 mode / storage_level → 400
    expect((await register(env, cookie, { id: 'x1', manifest: helloManifest, mode: 'quantum' })).status).toBe(400);
    expect((await register(env, cookie, { id: 'x2', manifest: helloManifest, storage_level: 'mega' })).status).toBe(400);

    // 空串归一为 null（不用空串占位）
    await register(env, cookie, { id: 'blank', manifest: helloManifest, mode: 'cloudflare', entry: '', storage_level: '' });
    const blank = db.first<Record<string, unknown>>("SELECT entry, storage_level FROM module_registry WHERE id = 'blank'");
    expect(blank).toEqual({ entry: null, storage_level: null });
  });

  it('守护：module_registry 行结构 == 迁移建表列（幻影列/漏列即红）', async () => {
    const { env, db, cookie } = await envFor('admin');
    expect(db.columns('module_registry')).toEqual([
      'id',
      'enabled',
      'version',
      'manifest_json',
      'entry',
      'storage_level',
      'mode',
      'credential_hash',
    ]);
    await register(env, cookie, { id: 'hello', manifest: helloManifest });

    // 真库全字段行：列集合必须与建表一致（历史幻影列会在此暴露）
    const row = db.first<Record<string, unknown>>('SELECT * FROM module_registry WHERE id = ?', 'hello');
    expect(Object.keys(row ?? {}).sort()).toEqual([...db.columns('module_registry')].sort());

    // 路由级：源码 SELECT 一旦引用不存在的列，这里就是 500（而非假 D1 的静默绿）
    const list = await app.request(REG_URL, { headers: { cookie } }, env);
    expect(list.status).toBe(200);
    const entries = (await list.json()) as Array<Record<string, unknown>>;
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual([
      'credential_hash',
      'enabled',
      'entry',
      'id',
      'manifest',
      'mode',
      'storage_level',
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

  it('守护：真 schema 约束生效（credential_hash 可空、无伪约束）', async () => {
    const { db } = await envFor('admin');
    db.run(
      "INSERT INTO module_registry (id, enabled, manifest_json, credential_hash) VALUES ('with', 1, '{}', ?)",
      'b'.repeat(64),
    );
    expect(db.first<{ credential_hash: string }>("SELECT credential_hash FROM module_registry WHERE id = 'with'")).toEqual({
      credential_hash: 'b'.repeat(64),
    });
    // 可空：不写即 NULL（0013 无 NOT NULL/CHECK——「保存后才必有值」是流程事实，非列约束）
    db.run("INSERT INTO module_registry (id, enabled, manifest_json) VALUES ('bare', 1, '{}')");
    expect(db.first<{ credential_hash: string | null }>("SELECT credential_hash FROM module_registry WHERE id = 'bare'")).toEqual({
      credential_hash: null,
    });
  });
});

describe('反连接入：POST /api/admin/modules/connect-register（#349，决策 #108 两段式）', () => {
  const KEY_HASH = 'c'.repeat(64);
  const CONNECT_URL = 'https://t.example/api/admin/modules/connect-register';

  function connectRegister(
    env: { JWT_PRIVATE_KEY: string; CORE_DB: D1Database },
    cookie: string,
    body: unknown,
  ) {
    return app.request(
      CONNECT_URL,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      env,
    );
  }

  it('注册成功：记账一行 pending 态（mode=connect + credential_hash + enabled=false），哈希只落哈希不入 manifest', async () => {
    const { env, db, cookie } = await envFor('admin');
    const res = await connectRegister(env, cookie, { moduleId: 'hello', keyHash: KEY_HASH });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 'hello', mode: 'connect', enabled: false });

    // 真库行：pending 态语义（保存前的记账态）；entry = core 隧道路由（请求 origin 推导）
    const row = db.first<Record<string, unknown>>(
      'SELECT enabled, mode, credential_hash, entry, storage_level, manifest_json FROM module_registry WHERE id = ?',
      'hello',
    );
    expect(row).toMatchObject({
      enabled: 0,
      mode: 'connect',
      credential_hash: KEY_HASH,
      entry: 'https://t.example/m/hello/',
      storage_level: null,
    });
    // 占位 manifest 不含哈希/明文（凭证只走 credential_hash 列）；entry = core 隧道路由
    expect(row!.manifest_json).not.toContain(KEY_HASH);
    expect(JSON.parse(row!.manifest_json as string)).toMatchObject({ id: 'hello', route: '/m/hello', entry: 'https://t.example/m/hello/' });
    // 记账动作留审计
    expect(db.query('SELECT action, target FROM audit_log')).toContainEqual({
      action: 'module_connect_registered',
      target: 'hello',
    });
  });

  it('keyHash 形状错拒：非 64 位小写 hex（大写/短哈希/非 hex/非串）都 400 人话且不落库', async () => {
    const { env, db, cookie } = await envFor('admin');
    const bads = [
      'C'.repeat(64), // 大写
      'c'.repeat(63), // 短一位
      'c'.repeat(65), // 长一位
      `x${'c'.repeat(63)}`, // 非 hex
      123, // 非串
    ];
    for (const keyHash of bads) {
      const res = await connectRegister(env, cookie, { moduleId: 'hello', keyHash });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; detail?: string };
      expect(body.detail ?? body.error).toContain('keyHash');
    }
    // 同理 moduleId 形状错拒
    expect((await connectRegister(env, cookie, { moduleId: 'Hello', keyHash: KEY_HASH })).status).toBe(400);
    expect(db.query('SELECT id FROM module_registry')).toEqual([]);
    expect(db.query('SELECT id FROM audit_log')).toEqual([]);
  });

  it('未知 storageLevel → 400 人话（zod 单点清单，不静默收编）', async () => {
    const { env, cookie } = await envFor('admin');
    const res = await connectRegister(env, cookie, { moduleId: 'hello', keyHash: KEY_HASH, storageLevel: 'mega' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? '').toContain('storageLevel');
  });

  it('重放幂等（双击/重试）：同一 moduleId 覆盖哈希，不建第二行；已选存储不因未写被冲掉（合并语义）', async () => {
    const { env, db, cookie } = await envFor('admin');
    // 第一次记账：带存储选择
    expect(
      (await connectRegister(env, cookie, { moduleId: 'hello', keyHash: 'a'.repeat(64), storageLevel: 'dedicated' })).status,
    ).toBe(201);
    // 重放：换哈希、不带存储 → 覆盖哈希，保留旧存储，仍只一行
    const again = await connectRegister(env, cookie, { moduleId: 'hello', keyHash: 'b'.repeat(64) });
    expect(again.status).toBe(201);
    const rows = db.query<Record<string, unknown>>(
      'SELECT credential_hash, storage_level, enabled FROM module_registry WHERE id = ?',
      'hello',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ credential_hash: 'b'.repeat(64), storage_level: 'dedicated', enabled: 0 });
  });

  it('两段式：保存（既有 POST /api/admin/modules upsert，未写 credential_hash）激活且哈希保留', async () => {
    const { env, db, cookie } = await envFor('admin');
    await connectRegister(env, cookie, { moduleId: 'hello', keyHash: KEY_HASH });
    // 第②段：测试连接绿 → 保存。manifest 快照入库、enabled=true；哈希未写保留（凭证不因保存被冲掉）
    const saved = await register(env, cookie, {
      id: 'hello',
      enabled: true,
      manifest: { ...helloManifest, description: '信箱' },
      mode: 'connect',
      entry: 'https://bridge.example.com/m/bridge/',
    });
    expect(saved.status).toBe(201);
    const row = db.first<Record<string, unknown>>(
      'SELECT enabled, credential_hash, mode, entry FROM module_registry WHERE id = ?',
      'hello',
    );
    expect(row).toEqual({
      enabled: 1,
      credential_hash: KEY_HASH,
      mode: 'connect',
      entry: 'https://bridge.example.com/m/bridge/',
    });
    // 真快照覆盖占位
    expect(JSON.parse(db.first<{ manifest_json: string }>("SELECT manifest_json FROM module_registry WHERE id = 'hello'")!.manifest_json)).toMatchObject({
      version: '1.0.0',
      description: '信箱',
    });
  });

  it('授权沿用管理守卫：无会话 401、普通成员 403（不落库不审计）', async () => {
    const { env, db, cookie } = await envFor('user');
    const anon = await app.request(CONNECT_URL, { method: 'POST', body: JSON.stringify({ moduleId: 'hello', keyHash: KEY_HASH }) }, env);
    expect(anon.status).toBe(401);
    const member = await connectRegister(env, cookie, { moduleId: 'hello', keyHash: KEY_HASH });
    expect(member.status).toBe(403);
    expect(db.query('SELECT id FROM module_registry')).toEqual([]);
    expect(db.query('SELECT id FROM audit_log')).toEqual([]);
  });

  it('pending 态不出现在成员侧清单（enabled=false 被过滤）；激活后以最小可见面出现', async () => {
    const { env, cookie } = await envFor('admin');
    await connectRegister(env, cookie, { moduleId: 'hello', keyHash: KEY_HASH });
    let memberList = (await (await app.request('https://t.example/api/modules', {}, env)).json()) as unknown[];
    expect(memberList).toEqual([]);
    await register(env, cookie, { id: 'hello', enabled: true, manifest: helloManifest, mode: 'connect', entry: 'https://bridge.example.com/m/bridge/' });
    memberList = (await (await app.request('https://t.example/api/modules', {}, env)).json()) as Array<Record<string, unknown>>;
    expect(memberList).toHaveLength(1);
    expect(Object.keys(memberList[0]!).sort()).toEqual(['enabled', 'id', 'manifest', 'name']);
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
