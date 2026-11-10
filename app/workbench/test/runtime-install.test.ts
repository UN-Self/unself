// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

import { gunzip, parseNpmSpec, pickTarball, untar } from '../src/services/npm-tarball';
import { installNpmModule, RuntimeInstallError, wipeCredential } from '../src/services/runtime-install';

/** 造一条 ustar 头（测试用最小实现：name ≤100、无 prefix、普通文件）。 */
function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name).subarray(0, 100), 0);
  header.set(enc.encode('0000644\0'), 100); // mode
  header.set(enc.encode('0000000\0'), 108); // uid
  header.set(enc.encode('0000000\0'), 116); // gid
  header.set(enc.encode(size.toString(8).padStart(11, '0') + '\0'), 124);
  header.set(enc.encode('00000000000\0'), 136); // mtime
  header[156] = '0'.charCodeAt(0);
  header.set(enc.encode('ustar\0'), 257);
  header.set(enc.encode('00'), 263);
  return header;
}

/** 打一个 tar（普通文件 + 结束块）。 */
function buildTar(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = enc.encode(content);
    chunks.push(tarHeader(name, bytes.byteLength), bytes);
    const pad = (512 - (bytes.byteLength % 512)) % 512;
    if (pad > 0) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** gzip 压缩（与运行时解压同一 Web API，双向对拍）。 */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const MANIFEST = {
  id: 'hello',
  route: '/m/hello',
  entry: 'https://team.example.com/m/hello/',
  runtimes: ['worker'],
  version: '1.2.3',
  permissions: ['storage'],
};

/** 假 npm + CF：元数据 / tarball / 脚本上传三段；记录每次调用的 url 与 header。 */
function fakeFetch(pkgFiles: Record<string, string>, opts?: { cfStatus?: number }) {
  const calls: Array<{ url: string; method: string; auth?: string }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push({
      url: target,
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers as Record<string, string> | undefined).get('authorization') ?? undefined,
    });
    if (target.endsWith('.tgz')) {
      return new Response(await gzip(buildTar(pkgFiles)));
    }
    if (target.includes('registry.npmjs.org')) {
      return Response.json({
        'dist-tags': { latest: '1.2.3' },
        versions: { '1.2.3': { dist: { tarball: 'https://registry.npmjs.org/@unself/hello/-/hello-1.2.3.tgz' } } },
      });
    }
    // CF 脚本上传
    if (target.includes('api.cloudflare.com')) {
      const status = opts?.cfStatus ?? 200;
      return Response.json(status === 200 ? { success: true, result: {} } : { success: false, errors: [{ message: 'auth denied' }] }, {
        status,
      });
    }
    return new Response('not found', { status: 404 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('npm 包读取（#349 模式一）', () => {
  it('规格解析：裸名 / 带版本 / scoped（与 installer npm: 语义一致）', () => {
    expect(parseNpmSpec('hello')).toEqual({ name: 'hello', version: null });
    expect(parseNpmSpec('@unself/hello@1.2.3')).toEqual({ name: '@unself/hello', version: '1.2.3' });
    expect(parseNpmSpec('npm:@unself/hello')).toEqual({ name: '@unself/hello', version: null });
  });

  it('tarball 选取：指定版本优先，缺 dist-tags 给人话错误', () => {
    const meta = {
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { dist: { tarball: 'https://r/1.0.0.tgz' } } },
    };
    expect(pickTarball(meta, { name: 'x', version: null }).version).toBe('1.0.0');
    expect(pickTarball(meta, { name: 'x', version: '1.0.0' }).tarballUrl).toBe('https://r/1.0.0.tgz');
    expect(() => pickTarball({}, { name: 'x', version: null })).toThrow(/dist-tags/);
  });

  it('tar 解包：文件内容与路径正确，gzip 往返一致', async () => {
    const tar = buildTar({ 'package/manifest.json': '{"id":"hello"}', 'package/worker.js': 'export default {}' });
    const roundTrip = await gunzip(await gzip(tar));
    const files = untar(roundTrip);
    expect(new TextDecoder().decode(files.get('package/manifest.json')!)).toBe('{"id":"hello"}');
    expect(files.has('package/worker.js')).toBe(true);
  });
});

describe('运行时装配（#349 模式一，决策 #109 凭证纪律）', () => {
  it('happy path：拉包 → 校 manifest → 上传 worker；token 只出现在 CF 那一跳', async () => {
    const { impl, calls } = fakeFetch({
      'package/manifest.json': JSON.stringify(MANIFEST),
      'package/worker.js': 'export default { fetch() { return new Response("ok") } }',
    });

    const result = await installNpmModule(
      { npmSpec: '@unself/hello@1.2.3', cfToken: 'cf-secret-token', accountId: 'acc-1' },
      impl,
    );

    expect(result.manifest.id).toBe('hello');
    expect(result.version).toBe('1.2.3');
    expect(result.scriptName).toBe('hello');
    // 三次网络：元数据 → tarball → 上传；token 只在第三次带出
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'PUT']);
    expect(calls[0]!.auth).toBeUndefined();
    expect(calls[1]!.auth).toBeUndefined();
    expect(calls[2]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc-1/workers/scripts/hello');
    expect(calls[2]!.auth).toBe('Bearer cf-secret-token');
  });

  it('未知能力：manifest 校验层直接拒（点名，不静默丢）', async () => {
    const { impl, calls } = fakeFetch({
      'package/manifest.json': JSON.stringify({ ...MANIFEST, permissions: ['storage', 'root-access'] }),
      'package/worker.js': 'export default {}',
    });
    await expect(
      installNpmModule({ npmSpec: 'hello', cfToken: 't', accountId: 'a' }, impl),
    ).rejects.toThrow(/manifest 校验失败/);
    // 校验没过就不该上传（不花用户的 CF 额度做无用功）
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('缺 manifest.json / worker.js：人话 400（不是 500）', async () => {
    const noManifest = fakeFetch({ 'package/worker.js': 'export default {}' });
    await expect(
      installNpmModule({ npmSpec: 'hello', cfToken: 't', accountId: 'a' }, noManifest.impl),
    ).rejects.toBeInstanceOf(RuntimeInstallError);

    const noWorker = fakeFetch({ 'package/manifest.json': JSON.stringify(MANIFEST) });
    await expect(
      installNpmModule({ npmSpec: 'hello', cfToken: 't', accountId: 'a' }, noWorker.impl),
    ).rejects.toThrow(/worker\.js/);
  });

  it('CF 拒绝：502 + 错误文案不含 token（#165：凭证不进异常面）', async () => {
    const { impl } = fakeFetch(
      { 'package/manifest.json': JSON.stringify(MANIFEST), 'package/worker.js': 'export default {}' },
      { cfStatus: 403 },
    );
    const error = await installNpmModule(
      { npmSpec: 'hello', cfToken: 'cf-secret-token', accountId: 'a' },
      impl,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeInstallError);
    expect((error as RuntimeInstallError).status).toBe(502);
    expect((error as Error).message).not.toContain('cf-secret-token');
  });

  it('wipeCredential 抹掉凭证引用（路由层 finally 调用）', () => {
    const holder = { cfToken: 'cf-secret-token' };
    wipeCredential(holder);
    expect(holder.cfToken).toBe('');
  });
});
