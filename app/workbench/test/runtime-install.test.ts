// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { gunzip, parseNpmSpec, pickTarball, untar } from '../src/services/npm-tarball';
import { installNpmModule, RuntimeInstallError, wipeCredential } from '../src/services/runtime-install';
import { buildTar, gzip, stubNpmFetch } from './helpers/fake-npm-package';

const MANIFEST = {
  id: 'hello',
  route: '/m/hello',
  entry: 'https://team.example.com/m/hello/',
  runtimes: ['worker'],
  version: '1.2.3',
  permissions: ['storage'],
};

function fakeFetch(pkgFiles: Record<string, string>, opts?: { cfStatus?: number }) {
  return stubNpmFetch(pkgFiles, opts) as { impl: typeof fetch; calls: Array<{ url: string; method: string; auth?: string }> };
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
