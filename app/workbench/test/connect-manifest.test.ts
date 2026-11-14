// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块自报 manifest（#349 U8 ①）与模块配置端点（U8 ④）行为测试：
 * - POST /api/modules/connect-manifest?keyHash=：keyHash 反查定位、schema 校验、
 *   覆盖 0.0.0 占位（version 非 0.0.0）、body id 不信任；
 * - GET/PUT /api/admin/modules/:id/config：schema 校验（unknown key 拒/type 校验/
 *   secret 打码与保持/oauth 拒）、审计；
 * - GET /api/module-api/config：Bearer 与 keyHash 双认证、无需权限词。
 * 断言打在 HTTP 响应与真 SQLite 行上（行为，非实现）。
 */
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { createCoreDb, type CoreTestDb } from './test-factory';

const app = createApp();

const pendingManifest = {
  id: 'bridge',
  route: '/m/bridge',
  runtimes: ['external'],
  version: '0.0.0',
};

const realManifest = {
  id: 'bridge',
  route: '/m/bridge',
  runtimes: ['external'],
  version: '1.4.2',
  description: 'bridge 模块',
  config: [
    { key: 'greeting', label: '问候语', type: 'string', required: true },
    { key: 'apiKey', label: '密钥', type: 'secret' },
    { key: 'level', label: '档位', type: 'enum', options: ['low', 'high'] },
    { key: 'loud', label: '大声', type: 'boolean' },
    { key: 'threshold', label: '阈值', type: 'number' },
    { key: 'homepage', label: '主页', type: 'url' },
    { key: 'extras', label: '扩展', type: 'json' },
    { key: 'sso', label: '单点', type: 'oauth' },
  ],
};

/** 记账一行 connect 占位（connect-register 端点，两段式第①段）并回 keyHash。 */
async function registerPending(db: CoreTestDb, moduleId = 'bridge', keyHash = `${'a'.repeat(64)}`): Promise<void> {
  db.run(
    `INSERT INTO module_registry (id, enabled, version, manifest_json, mode, entry, credential_hash)
     VALUES (?, 0, '0.0.0', ?, 'connect', ?, ?)`,
    moduleId,
    JSON.stringify(pendingManifest),
    `https://team.example.com/m/${moduleId}/`,
    keyHash,
  );
}

/** 造 admin 会话 Cookie 环境（同 registry.test envFor 模式）。 */
async function envFor(): Promise<{
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

describe('POST /api/modules/connect-manifest（U8 ①模块自报）', () => {
  it('keyHash 反查定位 + schema 过 → 覆盖 0.0.0 占位（manifest_json/version 更新，version 非 0.0.0）', async () => {
    const { env, db } = await envFor();
    const keyHash = 'a'.repeat(64);
    await registerPending(db, 'bridge', keyHash);

    const res = await app.request(
      `https://t.example/api/modules/connect-manifest?keyHash=${keyHash}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(realManifest),
      },
      env,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: 'bridge', version: '1.4.2' });

    const row = db.first<{ manifest_json: string; version: string }>(
      'SELECT manifest_json, version FROM module_registry WHERE id = ?',
      'bridge',
    );
    expect(row!.version).toBe('1.4.2');
    const stored = JSON.parse(row!.manifest_json) as Record<string, unknown>;
    expect(stored.config).toHaveLength(8);
    expect(stored.description).toBe('bridge 模块');
  });

  it('#349 U9：自报 body 带野 entry → 落库快照无 entry，entry 列仍是 core 隧道路由', async () => {
    const { env, db } = await envFor();
    const keyHash = 'c'.repeat(64);
    await registerPending(db, 'bridge', keyHash);

    // 模块自报一份带「自己的野地址」的清单——U9 后地址面归 core，这个键必须被剥离且列不被污染
    const wild = { ...realManifest, entry: 'https://wild.example.com/sneaky/' };
    const res = await app.request(
      `https://t.example/api/modules/connect-manifest?keyHash=${keyHash}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wild) },
      env,
    );
    expect(res.status).toBe(200);

    const row = db.first<{ manifest_json: string; entry: string | null }>(
      'SELECT manifest_json, entry FROM module_registry WHERE id = ?',
      'bridge',
    );
    const stored = JSON.parse(row!.manifest_json) as Record<string, unknown>;
    expect(stored).not.toHaveProperty('entry');
    expect(JSON.stringify(stored)).not.toContain('wild.example.com');
    // entry 列仍是 connect-register 写下的 core 路由，未被自报值污染
    expect(row!.entry).toBe('https://team.example.com/m/bridge/');
  });

  it('body 里的 id 不信任：报别人的 id 仍按 keyHash 定位写入正确行', async () => {
    const { env, db } = await envFor();
    const keyHash = 'b'.repeat(64);
    await registerPending(db, 'bridge', keyHash);

    const imposter = { ...realManifest, id: 'not-bridge' };
    const res = await app.request(
      `https://t.example/api/modules/connect-manifest?keyHash=${keyHash}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(imposter) },
      env,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: 'bridge' });
    expect(db.first<{ version: string }>('SELECT version FROM module_registry WHERE id = ?', 'bridge')!.version).toBe('1.4.2');
    expect(db.first<{ id: string }>('SELECT id FROM module_registry WHERE id = ?', 'not-bridge')).toBeNull();
  });

  it('未注册 keyHash → 404；形状非法 keyHash → 403（lookupConnectModule fail-closed 口径）', async () => {
    const { env } = await envFor();
    const unknown = await app.request(
      `https://t.example/api/modules/connect-manifest?keyHash=${'c'.repeat(64)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(realManifest) },
      env,
    );
    expect(unknown.status).toBe(404);

    const malformed = await app.request(
      'https://t.example/api/modules/connect-manifest?keyHash=not-hex',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(realManifest) },
      env,
    );
    expect(malformed.status).toBe(403);
  });
  it('非法 schema → 400 带 detail（version 缺失 / route 不以 /m/ 开头）', async () => {
    const { env, db } = await envFor();
    const keyHash = 'd'.repeat(64);
    await registerPending(db, 'bridge', keyHash);

    const badVersion = await app.request(
      `https://t.example/api/modules/connect-manifest?keyHash=${keyHash}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...realManifest, version: 'not-semver' }),
      },
      env,
    );
    expect(badVersion.status).toBe(400);
    const body = (await badVersion.json()) as { error: string; detail?: string };
    expect(body.error).toBe('invalid manifest');
    expect(body.detail).toBeTruthy();

    const badRoute = await app.request(
      `https://t.example/api/modules/connect-manifest?keyHash=${keyHash}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...realManifest, route: '/wrong' }),
      },
      env,
    );
    expect(badRoute.status).toBe(400);
    // 校验失败不落库：占位仍是 0.0.0
    expect(db.first<{ version: string }>('SELECT version FROM module_registry WHERE id = ?', 'bridge')!.version).toBe('0.0.0');
  });


const adminConfigUrl = (id: string) => `https://t.example/api/admin/modules/${id}/config`;

describe('GET/PUT /api/admin/modules/:id/config（U8 ④存值+读写）', () => {
  it('GET：声明 + 值回显；secret 已存值打码 ***，无声明回空数组不 404', async () => {
    const { env, db, cookie } = await envFor();
    await registerPending(db);
    // 有声明 + 存过值（secret 明文落库）
    db.run('UPDATE module_registry SET manifest_json = ?, config_values = ? WHERE id = ?',
      JSON.stringify(realManifest), JSON.stringify({ greeting: '你好', apiKey: 'sk-plain' }), 'bridge');

    const res = await app.request(adminConfigUrl('bridge'), { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const state = (await res.json()) as { config: Array<{ key: string }>; values: Record<string, unknown> };
    expect(state.config).toHaveLength(8);
    expect(state.values.greeting).toBe('你好');
    expect(state.values.apiKey).toBe('***'); // 不回显明文
    expect(JSON.stringify(state)).not.toContain('sk-plain');

    // 无声明（占位 manifest 无 config）→ 空数组 + 空对象，不 404（chat 行注册为占位）
    await registerPending(db, 'chat', 'e'.repeat(64));
    const bare = await app.request(adminConfigUrl('chat'), { headers: { cookie } }, env);
    expect(bare.status).toBe(200);
    await expect(bare.json()).resolves.toMatchObject({ config: [], values: {} });
  });

  it('GET 不存在的模块 → 404', async () => {
    const { env, cookie } = await envFor();
    const res = await app.request(adminConfigUrl('ghost'), { headers: { cookie } }, env);
    expect(res.status).toBe(404);
  });

  it('PUT：合法值落库（number 落数字/boolean 落布尔/json 落原文本）；返回落库产物', async () => {
    const { env, db, cookie } = await envFor();
    await registerPending(db);
    db.run('UPDATE module_registry SET manifest_json = ? WHERE id = ?', JSON.stringify(realManifest), 'bridge');

    const res = await app.request(adminConfigUrl('bridge'), {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        values: {
          greeting: '您好',
          threshold: '5', // 数字串也收（前端输入框原始串）
          loud: true,
          level: 'high',
          homepage: 'https://example.com',
          extras: '{"a":1}',
        },
      }),
    }, env);
    expect(res.status).toBe(200);
    // 响应只回 {id}：saved.values 可能含 secret，不回显（落库产物从真行断言）
    await expect(res.json()).resolves.toEqual({ id: 'bridge' });

    const row = db.first<{ config_values: string }>(
      'SELECT config_values FROM module_registry WHERE id = ?',
      'bridge',
    );
    expect(JSON.parse(row!.config_values!)).toMatchObject({ greeting: '您好', threshold: 5 });
  });

  it('PUT 校验：unknown key 拒 / type 不配拒 / enum 选项外拒 / oauth 拒 / required 缺拒——都不落库', async () => {
    const { env, db, cookie } = await envFor();
    await registerPending(db);
    db.run('UPDATE module_registry SET manifest_json = ? WHERE id = ?', JSON.stringify(realManifest), 'bridge');

    const put = (values: Record<string, unknown>) =>
      app.request(adminConfigUrl('bridge'), {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ values }),
      }, env);

    expect((await put({ nope: 'x' })).status).toBe(400); // unknown key
    expect((await put({ threshold: 'abc' })).status).toBe(400); // type 不配
    expect((await put({ loud: 'yes' })).status).toBe(400); // boolean 需布尔
    expect((await put({ level: 'medium' })).status).toBe(400); // enum 选项外
    expect((await put({ sso: 'anything' })).status).toBe(400); // oauth 不收填值
    expect((await put({})).status).toBe(400); // required 无值（此前未存）→ 拒

    expect(db.first<{ config_values: string | null }>(
      'SELECT config_values FROM module_registry WHERE id = ?', 'bridge',
    )!.config_values).toBeNull();
  });

  it('PUT secret 语义：掩码 *** 与空串 = 保持已存值；传真值 = 覆盖；响应不回显明文', async () => {
    const { env, db, cookie } = await envFor();
    await registerPending(db);
    db.run('UPDATE module_registry SET manifest_json = ?, config_values = ? WHERE id = ?',
      JSON.stringify(realManifest), JSON.stringify({ greeting: '旧', apiKey: 'sk-old-secret' }), 'bridge');

    const put = (values: Record<string, unknown>) =>
      app.request(adminConfigUrl('bridge'), {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ values }),
      }, env);

    const storedApiKey = (): string =>
      JSON.parse(db.first<{ config_values: string }>(
        'SELECT config_values FROM module_registry WHERE id = ?', 'bridge',
      )!.config_values!).apiKey as string;

    // *** + 空串都保持；其他值更新
    await put({ greeting: '新', apiKey: '***' });
    expect(storedApiKey()).toBe('sk-old-secret');

    await put({ apiKey: '' });
    expect(storedApiKey()).toBe('sk-old-secret');

    const overwrite = await put({ apiKey: '{{SECRET_z8sknth0}}' });
    expect(overwrite.status).toBe(200);
    expect(storedApiKey()).toBe('{{SECRET_z8sknth0}}');
    // 响应不回显 secret 明文（PUT 返回 saved.values）
    expect(JSON.stringify(await overwrite.json())).not.toContain('{{SECRET_z8sknth0}}');
  });

  it('PUT 落审计 module_config_updated；无 Cookie 被组合根拒', async () => {
    const { env, db, cookie } = await envFor();
    await registerPending(db);
    db.run('UPDATE module_registry SET manifest_json = ? WHERE id = ?', JSON.stringify(realManifest), 'bridge');

    await app.request(adminConfigUrl('bridge'), {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ values: { greeting: '审计' } }),
    }, env);
    expect(db.first<{ action: string }>("SELECT action FROM audit_log WHERE target = 'bridge' ORDER BY id DESC LIMIT 1")!.action)
      .toBe('module_config_updated');

    const anon = await app.request(adminConfigUrl('bridge'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { greeting: '匿名' } }),
    }, env);
    expect([401, 403]).toContain(anon.status);
  });
});

describe('GET /api/module-api/config（U8 ⑤模块读值）', () => {
  /** 真实签发模块 token（aud=bridge，module-api.test.ts 同款方式）。 */
  async function moduleToken(env: { JWT_PRIVATE_KEY: string }): Promise<string> {
    const { issueModuleToken, MODULE_TOKEN_ISSUER } = await import('../src/token');
    const { getSigningRuntime } = await import('../src/keys');
    const runtime = await getSigningRuntime(env.JWT_PRIVATE_KEY);
    const issued = await issueModuleToken(
      runtime!,
      { userId: 'u_1', moduleId: 'bridge', name: '成员' },
      { issuer: MODULE_TOKEN_ISSUER },
    );
    return issued.token;
  }

  it('Bearer token 轨：返回声明 + 真实值（secret 不打码——连接方是模块自己）；无需权限词', async () => {
    const { env, db } = await envFor();
    await registerPending(db);
    db.run(
      'UPDATE module_registry SET enabled = 1, manifest_json = ?, config_values = ? WHERE id = ?',
      JSON.stringify(realManifest),
      JSON.stringify({ greeting: '你好', apiKey: 'sk-plain' }),
      'bridge',
    );
    const token = await moduleToken(env);
    const res = await app.request(
      'https://t.example/api/module-api/config',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const state = (await res.json()) as { config: Array<{ key: string }>; values: Record<string, unknown> };
    expect(state.config.map((f) => f.key)).toContain('greeting');
    expect(state.values.greeting).toBe('你好');
    expect(state.values.apiKey).toBe('sk-plain'); // 模块读自己：不打码
  });

  it('keyHash 轨（connect 模块无 token）：query keyHash 反查定位；无 keyHash → 401', async () => {
    const { env, db } = await envFor();
    const keyHash = 'a'.repeat(64);
    await registerPending(db, 'bridge', keyHash);
    db.run(
      'UPDATE module_registry SET manifest_json = ?, config_values = ? WHERE id = ?',
      JSON.stringify(realManifest),
      JSON.stringify({ greeting: '哈希轨' }),
      'bridge',
    );

    const res = await app.request(
      `https://t.example/api/module-api/config?keyHash=${keyHash}`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ values: { greeting: '哈希轨' } });

    const badHash = await app.request(
      `https://t.example/api/module-api/config?keyHash=${'f'.repeat(64)}`,
      {},
      env,
    );
    expect(badHash.status).toBe(404); // 未注册哈希 fail-closed

    const none = await app.request('https://t.example/api/module-api/config', {}, env);
    expect(none.status).toBe(401);
  });

  it('disabled lifecycle：keyHash 轨一律 403（停用后模块不能再读配置/自报清单）', async () => {
    const { env, db } = await envFor();
    const keyHash = 'e'.repeat(64);
    await registerPending(db, 'bridge', keyHash);
    db.run("UPDATE module_registry SET enabled = 0, lifecycle = 'disabled' WHERE id = 'bridge'");

    const config = await app.request(
      `https://t.example/api/module-api/config?keyHash=${keyHash}`,
      {},
      env,
    );
    expect(config.status).toBe(403);

    const manifest = await app.request(
      `https://t.example/api/modules/connect-manifest?keyHash=${keyHash}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(realManifest) },
      env,
    );
    expect(manifest.status).toBe(403);
    // 被拒请求不改行：停用态与占位清单仍在
    const row = db.first<{ lifecycle: string; version: string }>(
      'SELECT lifecycle, version FROM module_registry WHERE id = ?',
      'bridge',
    );
    expect(row).toEqual({ lifecycle: 'disabled', version: '0.0.0' });
  });
});
});
