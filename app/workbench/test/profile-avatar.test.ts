// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { createSessionToken } from '../src/session';
import { upsertUser } from '../src/services/users';
import { createCoreDb } from './test-factory';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
async function setup() {
  const db = createCoreDb();
  const { privateKeyPem } = await generateInstanceKeyPair();
  const { id } = await upsertUser(db.d1, { issuer: 'builtin', sub: 'member', name: '成员' });
  const cookie = `unself_session=${await createSessionToken({ uid: id, iss: 'builtin', sub: 'member', name: '成员' }, privateKeyPem)}`;
  const objects = new Map<string, { bytes: ArrayBuffer; type: string }>();
  let fail = false;
  let gate: Promise<void> | null = null;
  let release: () => void;
  let waiting = 0;
  const bucket = {
    async put(key: string, bytes: ArrayBuffer, options: { httpMetadata: { contentType: string } }) {
      if (fail) throw new Error('store unavailable');
      if (gate) { if (++waiting === 2) release(); await gate; }
      objects.set(key, { bytes, type: options.httpMetadata.contentType });
      return { key };
    },
    async get(key: string) {
      const object = objects.get(key);
      return object ? { body: object.bytes, httpMetadata: { contentType: object.type } } : null;
    },
    async delete(key: string) { objects.delete(key); },
  };
  const env = { CORE_DB: db.d1, JWT_PRIVATE_KEY: privateKeyPem, PROFILE_FILES: bucket as unknown as R2Bucket };
  const app = createApp();
  const request = (path: string, init: RequestInit = {}, authenticated = true) => app.request(`https://team.example${path}`, {
    ...init, headers: { ...(authenticated ? { cookie } : {}), ...init.headers },
  }, env);
  const upload = (bytes: Uint8Array = png, type = 'image/png') => request('/api/me/avatar', {
    method: 'PUT', headers: { 'content-type': type }, body: bytes,
  });
  return { db, id, request, upload, objects, failStore: () => { fail = true; }, synchronizeUploads: () => { gate = new Promise<void>(resolve => { release = resolve; }); } };
}

describe('Core 头像与资料', () => {
  it('上传、替换、移除头像，旧会话和新模块 token 读取同一资料', async () => {
    const f = await setup();
    f.db.run('INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES (?, ?, ?, ?)', 'chat', 1, '1.0.0', '{}');
    const uploaded = await f.upload();
    expect(uploaded.status).toBe(200);
    const { avatarUrl } = await uploaded.json() as { avatarUrl: string };
    const imagePath = new URL(avatarUrl).pathname;
    const image = await f.request(imagePath);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    expect((await f.request(imagePath, {}, false)).status).toBe(401);
    const me = await (await f.request('/api/me')).json() as { user: { avatarUrl: string } };
    expect(me.user.avatarUrl).toBe(avatarUrl);
    const token = await (await f.request('/api/modules/chat/token', { method: 'POST' })).json() as { claims: { avatar_url: string; profile_revision: number } };
    expect(token.claims.avatar_url).toBe(avatarUrl);
    expect(token.claims.profile_revision).toBe(1);
    expect((await f.upload()).status).toBe(200);
    expect(f.objects.size).toBe(1);
    expect((await f.request(imagePath)).status).toBe(404);
    expect((await f.request('/api/me/avatar', { method: 'DELETE' })).status).toBe(200);
    expect(f.objects.size).toBe(0);
    expect((await (await f.request('/api/me')).json() as { user: { avatarUrl: string } }).user.avatarUrl).toBe('');
  });

  it('并发替换只有一个成功，落败请求不会删除已保存头像', async () => {
    const f = await setup();
    await f.upload();
    f.synchronizeUploads();
    const responses = await Promise.all([f.upload(), f.upload()]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect(f.objects.size).toBe(1);
    const me = await (await f.request('/api/me')).json() as { user: { avatarUrl: string } };
    expect((await f.request(new URL(me.user.avatarUrl).pathname)).status).toBe(200);
  });

  it('拒绝匿名、停用用户、伪造图片与超限文件，存储失败保留原头像', async () => {
    const f = await setup();
    expect((await f.request('/api/me/avatar', { method: 'PUT', body: png }, false)).status).toBe(401);
    expect((await f.upload(new TextEncoder().encode('<svg/>'))).status).toBe(400);
    expect((await f.upload(new Uint8Array(2 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await f.upload()).status).toBe(200);
    const before = await (await f.request('/api/me')).json();
    f.failStore();
    expect((await f.upload()).status).toBe(503);
    expect(await (await f.request('/api/me')).json()).toEqual(before);
    f.db.run('UPDATE users SET status = ? WHERE id = ?', 'disabled', f.id);
    expect((await f.request('/api/me/avatar', { method: 'DELETE' })).status).toBe(403);
    expect(f.objects.size).toBe(1);
  });
});
