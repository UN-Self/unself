// SPDX-License-Identifier: AGPL-3.0-only
// @ts-nocheck —— 直接测未加类型的 worker 源码（db-tables.js / files-s3.js），类型由运行时行为保障
// #310 新增（unself 集成层，非上游件）：files-s3 适配器行为测试。
// 边界（fake fetch）替换真实 S3；断言请求形状与 R2 同形返回，不断言内部实现。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createS3Files } from '../worker/src/files-s3.js';

const config = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'my-bucket',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret'
};

// 用独立实现（Python hashlib/hmac）预先算出的 SigV4 结果，锁死签名不漂移。
const EXPECTED_PUT_AUTHORIZATION =
  'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20240101/us-east-1/s3/aws4_request, ' +
  'SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-filename, ' +
  'Signature=8699339d61081508ea00c801e3264a70e65112b017447bd866e5e167e9293f0d';

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method,
      headers: new Headers(init.headers || {}),
      body: init.body
    };
    calls.push(call);
    return handler(call);
  });
  return { fetchImpl, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createS3Files 配置校验', () => {
  it.each(['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'])(
    '缺少 %s 时直接抛错，不静默回退',
    (field) => {
      expect(() => createS3Files({ ...config, [field]: '' })).toThrow(field);
    }
  );
});

describe('put', () => {
  it('发 PUT 到 bucket/key，带 SigV4 与自定义元数据头', async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 200 }));
    const files = createS3Files(config, fetchImpl);

    await files.put('user-1/file.txt', new TextEncoder().encode('hello'), {
      httpMetadata: { contentType: 'text/plain', cacheControl: 'private, no-store' },
      customMetadata: { filename: 'file.txt' }
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe('PUT');
    expect(call.url).toBe('https://s3.example.com/my-bucket/user-1/file.txt');
    expect(call.headers.get('content-type')).toBe('text/plain');
    expect(call.headers.get('cache-control')).toBe('private, no-store');
    expect(call.headers.get('x-amz-meta-filename')).toBe('file.txt');
    expect(call.headers.get('x-amz-content-sha256')).toMatch(/^[0-9a-f]{64}$/);

    const authorization = call.headers.get('authorization');
    expect(authorization).toContain('AWS4-HMAC-SHA256');
    expect(authorization).toContain('Credential=AKIDEXAMPLE/');
    expect(authorization).toContain('/us-east-1/s3/aws4_request');
    expect(authorization).toContain('SignedHeaders=');
  });

  it('SigV4 签名与独立实现一致（固定时刻，非自证循环）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 200 }));
    const files = createS3Files(config, fetchImpl);

    await files.put('user-1/file.txt', new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'text/plain', cacheControl: 'private, no-store' },
      customMetadata: { filename: 'file.txt' }
    });

    expect(calls[0].headers.get('authorization')).toBe(EXPECTED_PUT_AUTHORIZATION);
  });

  it('同输入同 Authorization（可复现）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const first = recordingFetch(() => new Response(null, { status: 200 }));
    const second = recordingFetch(() => new Response(null, { status: 200 }));

    await createS3Files(config, first.fetchImpl).put('user-1/file.txt', new Uint8Array([1, 2, 3]));
    await createS3Files(config, second.fetchImpl).put('user-1/file.txt', new Uint8Array([1, 2, 3]));

    expect(first.calls[0].headers.get('authorization')).toBe(
      second.calls[0].headers.get('authorization')
    );
  });
});

describe('get', () => {
  it('200 回 R2 同形对象，arrayBuffer 内容正确', async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(new TextEncoder().encode('ciphertext'), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'cache-control': 'private, no-store',
            'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
            'x-amz-meta-filename': 'file.txt'
          }
        })
    );
    const files = createS3Files(config, fetchImpl);

    const object = await files.get('user-1/file.txt');

    expect(calls[0].method).toBe('GET');
    expect(object).not.toBeNull();
    expect(object.uploaded).toEqual(new Date('2024-01-01T00:00:00.000Z'));
    expect(object.customMetadata).toEqual({ filename: 'file.txt' });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('cache-control')).toBe('private, no-store');

    const buffer = await object.arrayBuffer();
    expect(new TextDecoder().decode(buffer)).toBe('ciphertext');
  });

  it('404 回 null（调用方据此回 404）', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(null, { status: 404 }));
    const files = createS3Files(config, fetchImpl);

    expect(await files.get('user-1/missing.txt')).toBeNull();
  });
});

describe('delete', () => {
  it('发 DELETE 到 bucket/key', async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 204 }));
    const files = createS3Files(config, fetchImpl);

    await files.delete('user-1/file.txt');

    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('https://s3.example.com/my-bucket/user-1/file.txt');
    expect(calls[0].headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
  });
});

describe('list', () => {
  it('用 ListObjectsV2 查询并解析 objects', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents>
    <Key>a/one.txt</Key>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
    <Size>12</Size>
  </Contents>
  <Contents>
    <Key>b/two.txt</Key>
    <LastModified>2024-02-02T00:00:00.000Z</LastModified>
    <Size>34</Size>
  </Contents>
</ListBucketResult>`;
    const { fetchImpl, calls } = recordingFetch(() => new Response(xml, { status: 200 }));
    const files = createS3Files(config, fetchImpl);

    const result = await files.list({ limit: 250, prefix: 'a/' });

    expect(calls[0].method).toBe('GET');
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/my-bucket');
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('max-keys')).toBe('250');
    expect(url.searchParams.get('prefix')).toBe('a/');
    expect(calls[0].headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
    expect(result.objects).toEqual([
      { key: 'a/one.txt', size: 12, uploaded: new Date('2024-01-01T00:00:00.000Z') },
      { key: 'b/two.txt', size: 34, uploaded: new Date('2024-02-02T00:00:00.000Z') }
    ]);
  });

  it('空桶回空 objects', async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response('<?xml version="1.0"?><ListBucketResult></ListBucketResult>', { status: 200 })
    );
    const files = createS3Files(config, fetchImpl);

    expect(await files.list()).toEqual({ objects: [] });
  });
});

describe('失败态', () => {
  it('非 2xx（500）抛错，不静默', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('boom', { status: 500 }));
    const files = createS3Files(config, fetchImpl);

    await expect(files.put('user-1/file.txt', new Uint8Array([1]))).rejects.toThrow(/500/);
    await expect(files.get('user-1/file.txt')).rejects.toThrow(/500/);
    await expect(files.delete('user-1/file.txt')).rejects.toThrow(/500/);
    await expect(files.list()).rejects.toThrow(/500/);
  });
});
