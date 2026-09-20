// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/attachment-encryption-route.test.js（GPL-3.0-only，裁剪版）
import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { registerUploadRoutes } from './api/upload.js';
import { encryptAttachment } from './encryption.js';

const keyring = JSON.stringify({
  activeKeyId: 'v1',
  keys: {
    v1: Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => 255 - index)).toString('base64')
  }
});

function fileDb({ accessible, metadata = true }) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              if (sql.includes('SELECT filename, content_type, size')) {
                return metadata
                  ? { results: [{ filename: '报告.bin', content_type: 'application/octet-stream', size: 4 }] }
                  : { results: [] };
              }
              return { results: accessible ? [{ found: 1 }] : [] };
            }
          };
        }
      };
    }
  };
}

test('attachment upload reports when the deployment has no R2 binding', async () => {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    c.set('session', { userId: 42 });
    return next();
  });
  registerUploadRoutes(app);

  const formData = new FormData();
  formData.set('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
  const response = await app.request(
    'https://edgechat.test/api/upload',
    {
      method: 'POST',
      body: formData
    },
    {}
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: '当前部署没有绑定 R2，无法上传附件'
  });
});

test('authorized attachment download decrypts bytes and disables shared caching', async () => {
  const objectKey = '42/example.bin';
  const plaintext = Uint8Array.from([1, 2, 3, 4]);
  const ciphertext = await encryptAttachment(keyring, plaintext, objectKey);
  const object = {
    uploaded: new Date('2026-08-10T00:00:00Z'),
    customMetadata: {},
    async arrayBuffer() {
      return ciphertext.buffer;
    },
    writeHttpMetadata(headers) {
      headers.set('content-type', 'application/octet-stream');
      headers.set('cache-control', 'public, max-age=31536000');
    }
  };
  const app = new Hono();
  registerUploadRoutes(app);

  const response = await app.request(
    `https://edgechat.test/files/${objectKey}`,
    {},
    {
      DB: fileDb({ accessible: true }),
      FILES: {
        async get() {
          return object;
        }
      },
      EDGECHAT_ENCRYPTION_KEYRING: keyring
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), plaintext);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-disposition'), /%E6%8A%A5%E5%91%8A\.bin/);
});

test('unauthorized attachment download is rejected before reading R2', async () => {
  let r2Read = false;
  const app = new Hono();
  registerUploadRoutes(app);

  const response = await app.request(
    'https://edgechat.test/files/42/private.bin',
    {},
    {
      DB: fileDb({ accessible: false }),
      FILES: {
        async get() {
          r2Read = true;
          return null;
        }
      },
      EDGECHAT_ENCRYPTION_KEYRING: keyring
    }
  );

  assert.equal(response.status, 403);
  assert.equal(r2Read, false);
});

test('authorized attachment download reports when the deployment has no R2 binding', async () => {
  const app = new Hono();
  registerUploadRoutes(app);

  const response = await app.request(
    'https://edgechat.test/files/42/private.bin',
    {},
    { DB: fileDb({ accessible: true }) }
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: '当前部署没有绑定 R2，无法读取附件'
  });
});
