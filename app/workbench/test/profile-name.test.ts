// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { createSessionToken } from '../src/session';
import { getDisplayName, upsertUser } from '../src/services/users';
import { createCoreDb } from './test-factory';

describe('Core 昵称唯一写入点', () => {
  it('成员修改昵称后旧会话读到新值，OIDC 再登录也不覆盖', async () => {
    const db = createCoreDb();
    const { privateKeyPem } = await generateInstanceKeyPair();
    const identity = { issuer: 'https://idp.example', sub: 'member-1', name: '旧名字' };
    const { id } = await upsertUser(db.d1, identity);
    const cookie = `unself_session=${await createSessionToken({ uid: id, iss: identity.issuer, sub: identity.sub, name: identity.name }, privateKeyPem)}`;
    const app = createApp();
    const env = { CORE_DB: db.d1, JWT_PRIVATE_KEY: privateKeyPem };
    const changed = await app.request('https://team.example/api/me', {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: '新名字' }),
    }, env);
    expect(changed.status).toBe(200);
    expect(await getDisplayName(db.d1, id)).toBe('新名字');
    const me = await app.request('https://team.example/api/me', { headers: { cookie } }, env);
    expect(((await me.json()) as { user: { name: string } }).user.name).toBe('新名字');
    await upsertUser(db.d1, { ...identity, name: '身份源又改名' });
    expect(await getDisplayName(db.d1, id)).toBe('新名字');
    expect(db.first<{ profile_revision: number }>('SELECT profile_revision FROM users WHERE id = ?', id)?.profile_revision).toBe(1);
    db.run('INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES (?, ?, ?, ?)',
      'chat', 1, '1.0.0', JSON.stringify({ id: 'chat', route: '/m/chat', entry: 'https://team.example/m/chat/', runtimes: ['worker'], version: '1.0.0' }));
    const issued = await app.request('https://team.example/api/modules/chat/token', {
      method: 'POST', headers: { cookie },
    }, env);
    expect(issued.status).toBe(200);
    const token = (await issued.json()) as { claims: { name: string; profile_revision: number } };
    expect(token.claims.name).toBe('新名字');
    expect(token.claims.profile_revision).toBe(1);
  });

  it('匿名和无效昵称不能写入', async () => {
    const db = createCoreDb();
    const app = createApp();
    const env = { CORE_DB: db.d1, JWT_PRIVATE_KEY: (await generateInstanceKeyPair()).privateKeyPem };
    const anonymous = await app.request('https://team.example/api/me', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '冒名' }),
    }, env);
    expect(anonymous.status).toBe(401);
  });
});
