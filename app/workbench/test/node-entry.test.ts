// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node 运行体验收（#360 轨道 A/C/D）：
 * ① 真进程装配：entry.node 起服务 → /api/health 200；SPA 深链回 HTML 且带安全头；
 * ② 隧道真 WS：Node `ws` 客户端 dial-home → ready 帧 → /m/<id>/* 转发 → response 帧回 HTTP；
 * ③ 本地头像存储 put/get/delete + 路径穿越拒绝；
 * ④ S3 SigV4：AWS 官方示例向量（GET object）逐字节复算。
 *
 * 不打真 S3/真 PostgreSQL（后者已由 core/control-plane 的 UNSELF_TEST_PG_URL 用例覆盖）。
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteExecutor, openCoreDb } from '@unself/control-plane';
import { toD1Database, type TransactionRunner } from '../src/node/d1-executor';

import { startNode, type NodeHandle } from '../src/entry.node';
import { localAvatarStore } from '../src/adapters/local-avatar-store';
import { signS3Request } from '../src/adapters/s3-avatar-store';

/** AWS 文档示例（Signature Version 4 GET Object）的固定输入。 */
const AWS_VECTOR = {
  url: 'https://examplebucket.s3.amazonaws.com/test.txt',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  amzDate: '20130524T000000Z',
  signature: 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
};

const keyHashOf = (key: string): string => createHash('sha256').update(key).digest('hex');

describe('Node 运行体（#360）', () => {
  let root: string;
  let handle: NodeHandle;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'unself-node-'));
    const web = join(root, 'web');
    await mkdir(web, { recursive: true });
    await writeFile(
      join(web, 'index.html'),
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head><body>node shell</body></html>',
    );
    handle = await startNode({
      env: {},
      quiet: true,
      config: {
        database: { kind: 'sqlite', path: ':memory:' },
        files: null,
        host: '127.0.0.1',
        port: 0,
        dataDir: root,
        baseUrl: null,
        assetsDir: web,
      },
    });
  }, 30_000);

  afterAll(async () => {
    await handle?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('GET /api/health 200；SPA 深链 /setup 回 HTML 且带安全头', async () => {
    const health = await fetch(`${handle.url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: 'workbench' });

    const page = await fetch(`${handle.url}/setup?token=x`, { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(page.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('TunnelRoom 经 Node 真 WebSocket：dial-home → ready → forward → response', async () => {
    const key = 'node-tunnel-key';
    const keyHash = keyHashOf(key);
    await handle.runtime.env.CORE_DB.prepare(
      `INSERT INTO module_registry (id, enabled, version, manifest_json, mode, entry, credential_hash)
       VALUES (?, 0, '0.1.0', '{}', 'connect', ?, ?)`,
    )
      .bind('node-echo', 'https://core.invalid/m/node-echo/', keyHash)
      .run();

    const wsUrl = `${handle.url.replace(/^http/, 'ws')}/api/modules/connect-ws?keyHash=${keyHash}`;
    const socket = new WebSocket(wsUrl);
    const frames: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    socket.on('message', (data) => {
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
      for (const wake of waiters.splice(0)) wake();
    });
    const waitFor = async (predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
      for (;;) {
        const hit = frames.find(predicate);
        if (hit) return hit;
        await new Promise<void>((resolve, reject) => {
          waiters.push(resolve);
          socket.once('error', reject);
        });
      }
    };
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const ready = await waitFor((frame) => frame.type === 'ready');
      expect(ready).toMatchObject({ v: 1, type: 'ready', moduleId: 'node-echo' });

      const pending = fetch(`${handle.url}/m/node-echo/api/thing?id=7`);
      const request = await waitFor((frame) => frame.type === 'request');
      expect(request).toMatchObject({ v: 1, type: 'request', method: 'GET', path: '/api/thing', query: 'id=7' });
      socket.send(
        JSON.stringify({
          v: 1,
          type: 'response',
          requestId: request.requestId,
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: Buffer.from('tunnel-ok').toString('base64'),
        }),
      );

      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toBe('tunnel-ok');
    } finally {
      socket.close();
    }
  }, 15_000);

  it('本地头像存储 put/get/delete；路径穿越被拒', async () => {
    const dir = join(root, 'avatars');
    const store = localAvatarStore(dir);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await store.put('avatar-1', bytes.buffer, 'image/png');
    const loaded = await store.get('avatar-1');
    expect(loaded?.contentType).toBe('image/png');
    expect(new Uint8Array(loaded!.body as ArrayBuffer)).toEqual(bytes);
    await store.delete('avatar-1');
    expect(await store.get('avatar-1')).toBeNull();

    await expect(store.put('../escape', bytes.buffer, 'image/png')).rejects.toThrow(/key/);
    await expect(store.get('/etc/passwd')).rejects.toThrow(/key/);
  });

  it('S3 SigV4 复算 AWS 官方示例向量（Authorization 形状 + 签名）', async () => {
    const signed = await signS3Request({
      method: 'GET',
      url: AWS_VECTOR.url,
      headers: { range: 'bytes=0-9' },
      region: 'us-east-1',
      accessKeyId: AWS_VECTOR.accessKeyId,
      secretAccessKey: AWS_VECTOR.secretAccessKey,
      amzDate: AWS_VECTOR.amzDate,
    });
    expect(signed.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=[^/]+\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(signed.authorization.endsWith(AWS_VECTOR.signature)).toBe(true);
    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        '',
        'host:examplebucket.s3.amazonaws.com',
        'range:bytes=0-9',
        'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );

    const again = await signS3Request({
      method: 'GET',
      url: AWS_VECTOR.url,
      headers: { range: 'bytes=0-9' },
      region: 'us-east-1',
      accessKeyId: AWS_VECTOR.accessKeyId,
      secretAccessKey: AWS_VECTOR.secretAccessKey,
      amzDate: AWS_VECTOR.amzDate,
    });
    expect(again.canonicalRequest).toBe(signed.canonicalRequest);
    expect(again.authorization).toBe(signed.authorization);
  });
});

describe('D1 batch 适配（#360）：D1 的隐式事务语义落在 Node 运行体上', () => {
  /** 内存 sqlite + 最小表 + 带事务的 D1 形状。 */
  function makeD1(): { db: DatabaseSync; d1: D1Database } {
    const { db } = openCoreDb(':memory:');
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    const transaction: TransactionRunner = async (fn) => {
      db.exec('BEGIN');
      try {
        const result = await fn(new SqliteExecutor(db));
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    };
    return { db, d1: toD1Database(new SqliteExecutor(db), { transaction }) };
  }

  it('两条都成功：全部生效', async () => {
    const { db, d1 } = makeD1();
    try {
      await d1.batch([
        d1.prepare('INSERT INTO t (id) VALUES (?)').bind('a'),
        d1.prepare('INSERT INTO t (id) VALUES (?)').bind('b'),
      ]);
      expect(db.prepare('SELECT id FROM t ORDER BY id').all()).toEqual([{ id: 'a' }, { id: 'b' }]);
    } finally {
      db.close();
    }
  });

  it('第二条撞主键：第一条也回滚（不留半截数据）', async () => {
    const { db, d1 } = makeD1();
    try {
      await expect(
        d1.batch([
          d1.prepare('INSERT INTO t (id) VALUES (?)').bind('a'),
          d1.prepare('INSERT INTO t (id) VALUES (?)').bind('a'),
        ]),
      ).rejects.toThrow();
      // 关键：第一条必须一起回滚——否则会留下「有用户行、没凭据」的账号（永远登录不了）
      expect(db.prepare('SELECT id FROM t').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
