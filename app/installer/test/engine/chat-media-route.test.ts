// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect, it, vi } from 'vitest';
import { prefixStripWrapperSource } from '../../src/engine/assemble';

// Chat 发布入口是 JS；按包定位并加载它自己的数据库夹具，不把两个包的 TS 环境合并。
const chatEntry = pathToFileURL(createRequire(import.meta.url).resolve('@unself/chat'));
const { default: chatWorker } = await import(chatEntry.href);
const factoryUrl = new URL('../../test/chat-test-factory.ts', chatEntry);
const { createChatDb, MemoryKv, TEST_VARS } = await import(factoryUrl.href);
const { installRoomDo } = await import(new URL('../../test/do-stub.ts', chatEntry).href);

it('装配后的附件链路：真 JWT 上传与解密读取，公开频道消息附件也须登录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unself-chat-media-'));
  const db = createChatDb();
  try {
    // 只替换 Workers 运行时绑定；路由、JWT、SQL、加解密均执行真实模块代码。
    await writeFile(join(dir, 'app.js'), 'export default { fetch: (r, e, c) => e.CHAT_WORKER.fetch(r, e, c) };');
    await writeFile(join(dir, 'worker.js'), prefixStripWrapperSource('chat', { mount: '/m/chat', shellOrigin: 'https://team.example' }));
    const wrapper = (await import(pathToFileURL(join(dir, 'worker.js')).href)).default;
    const pair = await generateKeyPair('ES256', { extractable: true });
    const jwk = await exportJWK(pair.publicKey);
    const sign = (sub: string) => new SignJWT({ iss: 'unself-core', aud: 'chat', sub, name: sub })
      .setProtectedHeader({ alg: 'ES256', kid: 'media' }).setIssuedAt().setExpirationTime('10m').sign(pair.privateKey);
    const stored = new Map<string, { bytes: Uint8Array; httpMetadata: { contentType: string } }>();
    const assets = vi.fn(async () => new Response(null, { status: 404 }));
    const env = {
      DB: db.d1, SESSIONS: new MemoryKv(), ...TEST_VARS,
      CORE_JWKS_JSON: JSON.stringify({ keys: [{ ...jwk, kid: 'media', alg: 'ES256', use: 'sig' }] }),
      CHAT_WORKER: chatWorker, ASSETS: { fetch: assets },
      FILES: {
        async put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }) {
          stored.set(key, { bytes: new Uint8Array(value), httpMetadata: options.httpMetadata });
        },
        async get(key: string) {
          const file = stored.get(key);
          return file ? {
            arrayBuffer: async () => file.bytes.buffer,
            writeHttpMetadata: (headers: Headers) => headers.set('content-type', file.httpMetadata.contentType),
          } : null;
        },
      },
    };
    installRoomDo(env);
    const request = (path: string, init?: RequestInit) => wrapper.fetch(new Request(`https://team.example/m/chat${path}`, init), env, {});
    const ownerToken = await sign('media-owner');
    const headers = { authorization: `Bearer ${ownerToken}` };
    const image = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7TkAAAAASUVORK5CYII=', 'base64'));
    const body = new FormData();
    body.set('file', new File([image], 'photo.png', { type: 'image/png' }));
    const upload = await request('/api/upload', { method: 'POST', headers, body });
    expect(upload.status).toBe(200);
    const { file } = await upload.json() as { file: { key: string; url: string } };
    expect(file.url).toContain('%2F');
    const downloaded = await request(file.url, { headers });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-type')).toBe('image/png');
    expect(downloaded.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(image);
    expect(stored.get(file.key)?.bytes).not.toEqual(image);
    expect((await request(file.url)).status).toBe(403);
    expect((await request(file.url, { headers: { authorization: `Bearer ${await sign('media-other')}` } })).status).toBe(403);
    const sent = await request('/api/v1/rooms/public/1/messages', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '图片', attachment: file, clientMessageId: crypto.randomUUID() }),
    });
    expect(sent.status).toBe(200);
    const publicReader = await request(file.url, { headers: { authorization: `Bearer ${await sign('media-other')}` } });
    expect(publicReader.status).toBe(200);
    expect(new Uint8Array(await publicReader.arrayBuffer())).toEqual(image);
    expect((await request(file.url)).status).toBe(403);
    expect((await request(file.url, { headers: { authorization: 'Bearer invalid' } })).status).toBe(403);
    expect(assets).not.toHaveBeenCalled();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
