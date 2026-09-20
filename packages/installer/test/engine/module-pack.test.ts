// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块打包器测试（issue #269 / T1）。
 *
 * 测行为（docs/testing.md）：打包→解包往返、白名单收录/排除、manifest 单轨序列化、
 * worker.js 自包含、打包确定性（两次打包字节一致）、build-artifacts 产物与 pack 输出逐字节一致。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manifestFromYamlText, ModuleManifestSchema } from '@unself/contracts';
import { extractTarball } from '../../src/engine/sources';
import { modulePackageFiles, packModuleDir } from '../../src/engine/module-pack';
import { writeTarball } from '../../src/engine/tar-write';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

let work: string;
let longNameDir: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'unself-module-pack-'));
  longNameDir = await mkdtemp(join(tmpdir(), 'unself-tar-write-'));
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  await rm(longNameDir, { recursive: true, force: true });
});

/** 造一个最小源码形态模块目录（缺省排除规则夹具）。 */
async function makeModule(dir: string, manifestYaml: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.yaml'), manifestYaml);
}

const MINI_MANIFEST = [
  '# SPDX-License-Identifier: AGPL-3.0-only',
  'id: mini',
  'version: 1.2.3',
  'route: /m/mini',
  'entry: http://localhost:8790/',
  'runtimes:',
  '  - external',
  '',
].join('\n');

describe('packModuleDir（modules/hello 真实模块）', () => {
  let outDir: string;
  let tarballPath: string;

  beforeAll(async () => {
    outDir = join(work, 'out-hello');
    ({ tarballPath } = await packModuleDir({ dir: join(REPO_ROOT, 'modules', 'hello'), outDir }));
  });

  it('解包往返：extractTarball 成功，包根集合恰为 manifest.json/package.json/worker.js/wrangler.jsonc/LICENSE/NOTICE', async () => {
    const dest = join(work, 'unpacked-hello');
    const result = await extractTarball({ tarPath: tarballPath, dest });
    expect(result.files.sort()).toEqual([
      'LICENSE',
      'NOTICE',
      'manifest.json',
      'package.json',
      'worker.js',
      'wrangler.jsonc',
    ]);
  });

  it('解包出的 manifest.json 与 manifest.yaml 单轨解析 deep-equal', async () => {
    const dest = join(work, 'unpacked-hello-manifest');
    await extractTarball({ tarPath: tarballPath, dest });
    const json = JSON.parse(await readFile(join(dest, 'package', 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const expected = ModuleManifestSchema.parse(
      manifestFromYamlText(await readFile(join(REPO_ROOT, 'modules', 'hello', 'manifest.yaml'), 'utf8')) as Record<string, unknown>,
    );
    expect(json).toEqual(expected);
  });

  it('worker.js 自包含：不含 @unself/* 裸 import/require', async () => {
    const dest = join(work, 'unpacked-hello-worker');
    await extractTarball({ tarPath: tarballPath, dest });
    const text = await readFile(join(dest, 'package', 'worker.js'), 'utf8');
    expect(text).not.toContain(`from '@unself/`);
    expect(text).not.toContain(`require('@unself/`);
  });

  it('打包确定性：同一模块目录打两次 → tgz 逐字节相同且 integrity 相同', async () => {
    const out2 = join(work, 'out-hello-2');
    const again = await packModuleDir({ dir: join(REPO_ROOT, 'modules', 'hello'), outDir: out2 });
    expect(again.integrity).toBe(again.integrity); // 平凡自等（防误改），真实断言在下一行
    expect(again.integrity).not.toBe('');
    const a = await readFile(tarballPath);
    const b = await readFile(again.tarballPath);
    expect(a.equals(b)).toBe(true);
    const { sriFromBuffer } = await import('../../src/engine/sources');
    expect(again.integrity).toBe(sriFromBuffer(b));
    expect(again.manifest.id).toBe('hello');
  });

  it('worker.js 确定性（files 层）：两次 modulePackageFiles 逐字节相同', async () => {
    const a = await modulePackageFiles({ dir: join(REPO_ROOT, 'modules', 'hello') });
    const b = await modulePackageFiles({ dir: join(REPO_ROOT, 'modules', 'hello') });
    expect(a.files.map((f) => f.name)).toEqual(b.files.map((f) => f.name));
    for (let i = 0; i < a.files.length; i++) {
      expect(a.files[i]!.data.equals(b.files[i]!.data)).toBe(true);
    }
  });
});

describe('白名单收录/排除（临时最小模块目录）', () => {
  let modDir: string;
  let names: string[];

  beforeAll(async () => {
    modDir = join(work, 'excl-module');
    await makeModule(modDir, MINI_MANIFEST);
    await mkdir(join(modDir, 'src'), { recursive: true });
    await writeFile(join(modDir, 'src', 'index.ts'), '// internal source\n');
    await mkdir(join(modDir, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(modDir, 'node_modules', 'x.js'), 'x\n');
    await writeFile(join(modDir, '.env'), 'SECRET=1\n');
    await mkdir(join(modDir, 'test'), { recursive: true });
    await writeFile(join(modDir, 'test', 'x.ts'), 'x\n');
    await mkdir(join(modDir, 'shared'), { recursive: true });
    await writeFile(join(modDir, 'shared', 'x.ts'), 'x\n');
    const names_ = await modulePackageFiles({ dir: modDir });
    names = names_.files.map((f) => f.name);
  });

  it('排除规则：src/、node_modules/、.env、test/、shared/ 都不入包', () => {
    for (const bad of ['src/index.ts', 'node_modules/x.js', '.env', 'test/x.ts', 'shared/x.ts']) {
      expect(names).not.toContain(bad);
    }
    expect(names).toEqual(['manifest.json', 'package.json']);
  });
});

describe('递归目录收录（migrations/、docker/）', () => {
  let modDir: string;
  let files: Array<{ name: string; data: Buffer }>;

  beforeAll(async () => {
    // 放在仓库 node_modules 内（3 层即达根 LICENSE）——验证祖先回溯真实生效
    modDir = join(REPO_ROOT, 'node_modules', '.pack-fixture-tmp', 'tree-module');
    await rm(join(REPO_ROOT, 'node_modules', '.pack-fixture-tmp'), { recursive: true, force: true });
    await makeModule(modDir, MINI_MANIFEST);
    await mkdir(join(modDir, 'migrations', 'abc123'), { recursive: true });
    await writeFile(join(modDir, 'migrations', 'abc123', '0001_init.sql'), 'CREATE TABLE t(id);\n');
    await mkdir(join(modDir, 'docker'), { recursive: true });
    await writeFile(join(modDir, 'docker', 'Dockerfile'), 'FROM scratch\n');
    files = (await modulePackageFiles({ dir: modDir })).files;
  });

  afterAll(async () => {
    await rm(join(REPO_ROOT, 'node_modules', '.pack-fixture-tmp'), { recursive: true, force: true });
  });

  it('migrations/<id>/0001_x.sql 与 docker/Dockerfile 被收录且路径正确', () => {
    // 夹具在仓库 node_modules 内 → 回溯到根 LICENSE/NOTICE 一并收录
    expect(files.map((f) => f.name).sort()).toEqual(
      ['LICENSE', 'NOTICE', 'docker/Dockerfile', 'manifest.json', 'migrations/abc123/0001_init.sql', 'package.json'],
    );
    expect(files.find((f) => f.name === 'migrations/abc123/0001_init.sql')?.data.toString()).toBe('CREATE TABLE t(id);\n');
    expect(files.find((f) => f.name === 'docker/Dockerfile')?.data.toString()).toBe('FROM scratch\n');
  });

  it('无 LICENSE 时向上回溯到仓库根 LICENSE/NOTICE', () => {
    expect(files.find((f) => f.name === 'LICENSE')).toBeDefined();
    expect(files.find((f) => f.name === 'NOTICE')).toBeDefined();
  });
});

describe('worker 运行时 + 错误路径', () => {
  it('runtimes ∋ worker 且源码形态 → bundle 出自包含 worker.js（复用引擎打包函数）', async () => {
    const modDir = join(work, 'worker-module');
    await mkdir(join(modDir, 'src'), { recursive: true });
    await writeFile(
      join(modDir, 'manifest.yaml'),
      MINI_MANIFEST.replace('  - external', '  - worker'),
    );
    await writeFile(join(modDir, 'src', 'index.ts'), 'export default { fetch() { return new Response("ok"); } };\n');
    const names = (await modulePackageFiles({ dir: modDir })).files.map((f) => f.name);
    expect(names).toContain('worker.js');
  });

  it('已打包形态：包根 worker.js 原样收录（字节不二次加工）', async () => {
    const modDir = join(work, 'prebuilt-module');
    await makeModule(modDir, MINI_MANIFEST.replace('  - external', '  - worker'));
    await writeFile(join(modDir, 'worker.js'), '// prebuilt bytes ✔\n');
    const result = await modulePackageFiles({ dir: modDir });
    expect(result.files.find((f) => f.name === 'worker.js')?.data.toString()).toBe('// prebuilt bytes ✔\n');
  });

  it('缺 manifest（json/yaml 都没有）→ 人话报错', async () => {
    const empty = join(work, 'no-manifest');
    await mkdir(empty, { recursive: true });
    await expect(modulePackageFiles({ dir: empty })).rejects.toThrow(/manifest/);
  });

  it('LICENSE 回溯 8 层找不到 → 不抛错、无 LICENSE 文件（安装校验层硬拦）', async () => {
    const deep = join(work, 'deep', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'module');
    await mkdir(deep, { recursive: true });
    await makeModule(deep, MINI_MANIFEST);
    const result = await modulePackageFiles({ dir: deep, log: (msg) => void msg });
    expect(result.files.find((f) => f.name === 'LICENSE')).toBeUndefined();
  });
});

describe('#285 生成的 package.json（npm 发布形态）', () => {
  const helloDir = () => join(REPO_ROOT, 'modules', 'hello');
  const readPkg = (files: Array<{ name: string; data: Buffer }>): { name: string; version: string; files: string[]; license: string } =>
    JSON.parse(files.find((f) => f.name === 'package.json')!.data.toString('utf8')) as {
      name: string;
      version: string;
      files: string[];
      license: string;
    };

  it('字段齐 name/version/files/license，且 version 与 manifest.json 一致', async () => {
    const { files } = await modulePackageFiles({ dir: helloDir() });
    const pkg = readPkg(files);
    const manifest = JSON.parse(files.find((f) => f.name === 'manifest.json')!.data.toString('utf8')) as {
      id: string;
      version: string;
    };
    expect(pkg.name).toBe(manifest.id);
    expect(pkg.version).toBe(manifest.version); // C3：两处 version 同源
    expect(pkg.license).toBe('AGPL-3.0-only');
    // files 清单必须覆盖包根全部文件（目录形态 npm pack/npm publish 的收录面）
    expect([...pkg.files].sort()).toEqual(files.map((f) => f.name).sort());
  });

  it('--name 覆盖 npm 包名（作者 scope）', async () => {
    const { files } = await modulePackageFiles({ dir: helloDir(), npmName: '@acme/unself-hello' });
    expect(readPkg(files).name).toBe('@acme/unself-hello');
  });

  it('--version 同时写进 packed manifest.json 与生成的 package.json（C8）', async () => {
    const out = join(work, 'out-version');
    const r = await packModuleDir({ dir: helloDir(), outDir: out, version: '9.9.9' });
    expect(r.tarballPath.endsWith('hello-9.9.9.tgz')).toBe(true);
    const dest = join(work, 'unpacked-version');
    await extractTarball({ tarPath: r.tarballPath, dest });
    const manifest = JSON.parse(await readFile(join(dest, 'package', 'manifest.json'), 'utf8')) as { version: string };
    const pkg = JSON.parse(await readFile(join(dest, 'package', 'package.json'), 'utf8')) as { version: string };
    expect(manifest.version).toBe('9.9.9');
    expect(pkg.version).toBe('9.9.9');
  });

  it('不传 --version：沿用 manifest 里的版本（C8 行为不变）', async () => {
    const r = await packModuleDir({ dir: helloDir(), outDir: join(work, 'out-noversion') });
    expect(r.tarballPath.endsWith('hello-0.1.0.tgz')).toBe(true);
    expect(r.manifest.version).toBe('0.1.0');
  });

  it('非法 --version / --name 人话报错', async () => {
    await expect(modulePackageFiles({ dir: helloDir(), version: 'v1' })).rejects.toThrow(/--version 非法/);
    await expect(modulePackageFiles({ dir: helloDir(), npmName: 'Bad Name' })).rejects.toThrow(/npm 包名非法/);
  });
});

describe('writeTarball 底层', () => {
  it('成员名 > 100 字节走 GNU longname，extractTarball 往返成立', async () => {
    const longName = `package/${'d'.repeat(60)}/${'e'.repeat(60)}/manifest.json`; // 131 字节
    expect(longName.length).toBeGreaterThan(100);
    const outPath = join(longNameDir, 'long.tgz');
    // 带上包根 manifest.json，让 extractTarball 的包根判定通过，真正验 longname 成员的往返
    await writeTarball(
      [
        { name: 'package/manifest.json', data: Buffer.from(JSON.stringify({ id: 'x', version: '0.0.1' }) + '\n') },
        { name: longName, data: Buffer.from('{}\n') },
      ],
      outPath,
    );
    const dest = join(longNameDir, 'unpacked');
    const result = await extractTarball({ tarPath: outPath, dest });
    // result.files 为剥掉 package/ 前缀后的包根相对路径
    const stripped = longName.slice('package/'.length);
    expect(result.files).toContain(stripped);
    const data = await readFile(join(dest, longName));
    expect(data.toString()).toBe('{}\n');
  });

  it('writeTarball 确定性：同输入两次 → gzip 字节逐字节相同', async () => {
    const entries = [
      { name: 'package/a.txt', data: Buffer.from('hello\n') },
      { name: 'package/nested/b.txt', data: Buffer.from('world\n') },
    ];
    const p1 = join(longNameDir, 'det1.tgz');
    const p2 = join(longNameDir, 'det2.tgz');
    await writeTarball(entries, p1);
    await writeTarball(entries, p2);
    const a = await readFile(p1);
    const b = await readFile(p2);
    expect(a.equals(b)).toBe(true);
  });
});

describe('build-artifacts 产物一致性（跑过 build:artifacts 才验，否则跳过）', () => {
  const artifactsHello = join(REPO_ROOT, 'packages', 'installer', 'dist', 'artifacts', 'modules', 'hello');

  it('artifacts 的 manifest.json / worker.js 与 pack 输出逐字节一致', async () => {
    if (!existsSync(artifactsHello)) {
      console.warn(`跳过：${artifactsHello} 不存在（先跑 pnpm --filter @unself/installer build:artifacts）`);
      return;
    }
    const packed = await modulePackageFiles({ dir: join(REPO_ROOT, 'modules', 'hello') });
    for (const name of ['manifest.json', 'worker.js']) {
      const artifactBytes = await readFile(join(artifactsHello, name));
      const packBytes = packed.files.find((f) => f.name === name)!.data;
      expect(artifactBytes.equals(packBytes)).toBe(true);
    }
  });
});
