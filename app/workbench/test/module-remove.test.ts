// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';

const app = createApp();
import { checkTokenGate } from '../src/token';
import { createCoreDb, type CoreTestDb } from './test-factory';

const helloManifest = {
  id: 'hello',
  route: '/m/hello',
  entry: 'https://team.example.com/m/hello/',
  runtimes: ['worker'],
  version: '1.0.0',
  icon: 'inbox',
};

/** 与 registry.test.ts 同款环境：admin 会话 Cookie + 真库（迁移 0001 建表）。 */
async function envFor(): Promise<{
  env: { JWT_PRIVATE_KEY: string; CORE_DB: D1Database };
  db: CoreTestDb;
  cookie: string;
}> {
  const { generateInstanceKeyPair } = await import('../src/keys');
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

function remove(
  env: { JWT_PRIVATE_KEY: string; CORE_DB: D1Database },
  cookie: string,
  id: string,
) {
  return app.request(`${REG_URL}/${id}`, { method: 'DELETE', headers: { cookie } }, env);
}

describe('DELETE /api/admin/modules/:id（#270 T6：注册表移除 = token 失效）', () => {
  it('删除已有模块：200 { id, removed: true }，注册表行消失，审计留 module_removed', async () => {
    const { env, db, cookie } = await envFor();
    await register(env, cookie, { id: 'hello', enabled: true, manifest: helloManifest });

    const res = await remove(env, cookie, 'hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'hello', removed: true });

    // 注册表行真消失（不是替身 Map）
    expect(db.first('SELECT * FROM module_registry WHERE id = ?', 'hello')).toBeNull();

    // 审计真落 audit_log（失败不伪造留痕的反向：成功必留痕）
    expect(
      db.query<{ actor: string; action: string; target: string }>(
        'SELECT actor, action, target FROM audit_log WHERE action = ?',
        'module_removed',
      ),
    ).toEqual([{ actor: 'u_admin', action: 'module_removed', target: 'hello' }]);
  });

  it('删除不存在的模块：404（幂等语义：未注册即无操作），不写审计', async () => {
    const { env, db, cookie } = await envFor();
    const res = await remove(env, cookie, 'ghost');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'module not found' });
    expect(db.query('SELECT id FROM audit_log')).toEqual([]);
  });

  it('删除后 token 门禁对该 id 回 404（贴实现：行删除即 checkTokenGate 查无此行）', async () => {
    const { env, db, cookie } = await envFor();
    await register(env, cookie, { id: 'hello', enabled: true, manifest: helloManifest });

    // 删除前门禁通过
    expect((await checkTokenGate(db.d1, 'hello')).ok).toBe(true);

    await remove(env, cookie, 'hello');

    // 删除后行不存在 → 404：已签 token 虽未到期，但换发与模块 API 门禁都过不了注册表这关
    const gate = await checkTokenGate(db.d1, 'hello');
    expect(gate).toEqual({ ok: false, status: 404, error: 'module not found' });

    // 端到端口径：token 签发端点同样 404（同一门禁）
    const issue = await app.request(
      'https://t.example/api/modules/hello/token',
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(issue.status).toBe(404);
    expect(await issue.json()).toEqual({ error: 'module not found' });
  });
});
