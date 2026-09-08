// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import app from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';

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

/** 内存 D1：覆盖 registry CRUD + users 角色查询的最小面。 */
interface RegistryDb {
  _registry: Map<
    string,
    { id: string; enabled: number; version: string | null; manifest_json: string }
  >;
  _users: Map<
    string,
    { id: string; issuer: string; sub: string; display_name: string; role: string }
  >;
  _audit: Array<{ action: string; target: string | null }>;
}

function makeDb(): D1Database & RegistryDb {
  type RegistryRow = RegistryDb['_registry'] extends Map<string, infer R> ? R : never;
  type UserRow = RegistryDb['_users'] extends Map<string, infer R> ? R : never;
  const registry = new Map<string, RegistryRow>();
  const users = new Map<string, UserRow>();
  const auditLog: RegistryDb['_audit'] = [];
  const db = {
    prepare(sql: string) {
      const chain = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          chain._args = args;
          return chain;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('UPDATE module_registry')) {
            const row = registry.get(chain._args[1] as string);
            if (!row) return null;
            row.enabled = chain._args[0] as number;
            return { id: row.id, enabled: row.enabled } as T;
          }
          if (sql.includes('FROM users')) {
            return (users.get(chain._args[0] as string) as T) ?? null;
          }
          return null;
        },
        async all<T>() {
          if (sql.includes('FROM module_registry')) {
            const rows = [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
            return { results: rows as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (sql.includes('INSERT INTO module_registry')) {
            const [id, enabled, version, manifestJson] = chain._args as [string, number, string, string];
            registry.set(id, { id, enabled, version, manifest_json: manifestJson });
          } else if (sql.includes('INSERT INTO audit_log')) {
            auditLog.push({
              action: chain._args[1] as string,
              target: (chain._args[2] as string) ?? null,
            });
          }
          return { success: true };
        },
      };
      return chain;
    },
  };
  return { prepare: db.prepare, _registry: registry, _users: users, _audit: auditLog } as unknown as D1Database & RegistryDb;
}

/** 造一个带 admin/user 会话 Cookie 的环境。 */
async function envFor(role: 'admin' | 'user') {
  const pair = await generateInstanceKeyPair();
  const { createSessionToken } = await import('../src/session');
  const token = await createSessionToken(
    { uid: `u_${role}`, iss: 'https://idp', sub: `sub-${role}`, name: role },
    pair.privateKeyPem,
  );
  const db = makeDb();
  db._users.set('u_admin', { id: 'u_admin', issuer: 'https://idp', sub: 'sub-admin', display_name: '管理', role: 'admin' });
  db._users.set('u_user', { id: 'u_user', issuer: 'https://idp', sub: 'sub-user', display_name: '成员', role: 'user' });
  return { env: { JWT_PRIVATE_KEY: pair.privateKeyPem, CORE_DB: db as unknown as D1Database }, db, cookie: `unself_session=${token}` };
}

describe('registry CRUD 与启停语义（#7）', () => {
  it('注册模块：写入 manifest 快照，201 返回条目', async () => {
    const { env, db, cookie } = await envFor('admin');
    const res = await app.request(
      'https://t.example/api/admin/modules',
      { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'hello', enabled: true, manifest: helloManifest }) },
      env,
    );
    expect(res.status).toBe(201);
    const entry = (await res.json()) as { id: string; enabled: boolean; version: string };
    expect(entry.id).toBe('hello');
    expect(entry.enabled).toBe(true);
    expect(entry.version).toBe('1.0.0');
    expect(db._registry.get('hello')?.manifest_json).toContain('"counter"');
  });

  it('重复注册 upsert：刷新快照不炸（deploy 脚本幂等重跑）', async () => {
    const { env, cookie } = await envFor('admin');
    const body = JSON.stringify({ id: 'hello', enabled: true, manifest: helloManifest });
    const base = 'https://t.example/api/admin/modules';
    expect((await app.request(base, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body }, env)).status).toBe(201);
    const v2 = { ...helloManifest, version: '1.0.1' };
    const again = await app.request(base, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'hello', enabled: true, manifest: v2 }) }, env);
    expect(again.status).toBe(201);
    const list = (await (await app.request(base, { headers: { cookie } }, env)).json()) as Array<{
      version: string;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.version).toBe('1.0.1');
  });

  it('enabled 翻转生效；不存在的模块 404', async () => {
    const { env, db, cookie } = await envFor('admin');
    await app.request(
      'https://t.example/api/admin/modules',
      { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'hello', manifest: helloManifest }) },
      env,
    );
    const off = await app.request(
      'https://t.example/api/admin/modules/hello/enabled',
      { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: '{"enabled":false}' },
      env,
    );
    expect(off.status).toBe(200);
    expect(db._registry.get('hello')?.enabled).toBe(0);
    const on = await app.request(
      'https://t.example/api/admin/modules/hello/enabled',
      { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: '{"enabled":true}' },
      env,
    );
    expect(await on.json()).toEqual({ id: 'hello', enabled: true });
    const ghost = await app.request(
      'https://t.example/api/admin/modules/ghost/enabled',
      { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: '{"enabled":true}' },
      env,
    );
    expect(ghost.status).toBe(404);
  });

  it('成员视角 GET /api/modules 只回 enabled；管理端回全量', async () => {
    const { env, cookie } = await envFor('admin');
    const reg = 'https://t.example/api/admin/modules';
    const post = (id: string, enabled: boolean) =>
      app.request(reg, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id, enabled, manifest: { ...helloManifest, id } }) }, env);
    await post('hello', true);
    await post('chat', false);
    const adminList = (await (await app.request(reg, { headers: { cookie } }, env)).json()) as Array<{
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
    const reg = 'https://t.example/api/admin/modules';
    const anon = await app.request(reg, { method: 'POST' }, env);
    expect(anon.status).toBe(401);
    const member = await app.request(
      reg,
      { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'hello', manifest: helloManifest }) },
      env,
    );
    expect(member.status).toBe(403);
    const adminEnv = await envFor('admin');
    const badBody = await app.request(
      reg,
      { method: 'POST', headers: { cookie: adminEnv.cookie, 'content-type': 'application/json' }, body: '{"id":"HELLO","manifest":{}}' },
      adminEnv.env,
    );
    expect(badBody.status).toBe(400);
    const badToggle = await app.request(
      'https://t.example/api/admin/modules/hello/enabled',
      { method: 'PATCH', headers: { cookie: adminEnv.cookie, 'content-type': 'application/json' }, body: '{"enabled":"yes"}' },
      adminEnv.env,
    );
    expect(badToggle.status).toBe(400);
  });

  it('启停动作写入审计', async () => {
    const { env, db, cookie } = await envFor('admin');
    await app.request(
      'https://t.example/api/admin/modules',
      { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'hello', manifest: helloManifest }) },
      env,
    );
    await app.request(
      'https://t.example/api/admin/modules/hello/enabled',
      { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: '{"enabled":false}' },
      env,
    );
    expect(db._audit.map((a) => a.action)).toContain('module_disabled');
  });
});
