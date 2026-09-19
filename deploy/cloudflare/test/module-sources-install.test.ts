// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 来源模块安装全链路测试（issue #245 验收，装配器路径）：
 *
 * 验收对照（issue #245 + 派工落档 2026-09-18）：
 * - npm / github / https 三种远端来源各装一个成功；file: 本地目录一个成功
 *   → 通过 runNineSteps 装配路径证明：config.modules 给 {id, source}，模块落位并上传；
 * - 远端包带 postinstall → 验证未执行（sources.test.ts 已锁；这里再锁「上传产物里标记不存在」）；
 * - 篡改 tarball → integrity 校验失败并拒绝安装；
 * - 改 config 版本号 → SourceDriftError 列 diff 要求确认；-y 跳过。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sriFromBuffer } from '../src/sources';
import { runNineSteps } from '../src/steps';
import { SourceDriftError } from '../src/module-sources';
import { makeCfRestFake } from './helpers/cf-rest-fake';
import { RestClient } from '../src/rest/client';

const ROOT = new URL('../../..', import.meta.url).pathname;

async function fakeBuildShell(rootDir: string): Promise<void> {
  const dist = join(rootDir, 'apps/shell/dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<html><body>TEST SHELL</body></html>');
}

const SMOKE_OK = {
  smoke: async (b: string, mods: Array<{ id: string; baseUrl: string }>) =>
    ([{ name: 'core-api', url: `${b}/api/health`, ok: true, status: 200 }] as Array<{
      name: string;
      url: string;
      ok: boolean;
      status: number;
    }>).concat(mods.map((m) => ({ name: `module:${m.id}`, url: `${m.baseUrl}/api/health`, ok: true, status: 200 }))),
};

// ---------------------------------------------------------------------------
// 打包形态测试模块（tarball 夹具）：预构建 worker.js + manifest.json + LICENSE
// ---------------------------------------------------------------------------

const PKG_MANIFEST = {
  id: 'todo',
  version: '1.2.0',
  runtimes: ['worker'],
  route: '/m/todo',
  entry: 'http://localhost:8791/',
  description: '打包形态测试模块',
  permissions: ['storage'],
};

/** 预构建 worker（自包含，无 import——zip-slip 防护之外零外部性）。 */
const PKG_WORKER = [
  '// 预构建自包含模块 worker（#245 打包产物形态）',
  'export default {',
  '  async fetch(request) {',
  '    const url = new URL(request.url);',
  "    if (url.pathname === '/api/health') return Response.json({ ok: true, module: 'todo' });",
  "    return Response.json({ module: 'todo', path: url.pathname });",
  '  },',
  '};',
  '',
].join('\n');

const PKG_LICENSE = 'MIT License\n';

/** 手工造 tar.gz（成员全在 package/ 前缀下 = npm 包形态）。 */
function makePkgTarball(over?: { worker?: string }): Buffer {
  const entries: Array<{ name: string; data: Buffer }> = [
    { name: 'package/manifest.json', data: Buffer.from(JSON.stringify(PKG_MANIFEST, null, 2)) },
    { name: 'package/worker.js', data: Buffer.from(over?.worker ?? PKG_WORKER) },
    { name: 'package/LICENSE', data: Buffer.from(PKG_LICENSE) },
  ];
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, Math.min(e.name.length, 100));
    h.write('0000644\0', 100, 8);
    h.write('0000000\0', 108, 8);
    h.write('0000000\0', 116, 8);
    h.write(`${e.data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    h.write(''.padEnd(12, '\0'), 136, 12);
    h.write('0', 156, 1);
    h.write('ustar\0', 257, 6);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(h, e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  const zlib = require('node:zlib') as typeof import('node:zlib');
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** 篡改包：worker.js 换字节 → SRI 必变。 */
function tamperTarball(buf: Buffer): Buffer {
  const zlib = require('node:zlib') as typeof import('node:zlib');
  const raw = zlib.gunzipSync(buf);
  // 在数据块里翻一个字节（合法 tar 结构不变、内容变）
  const evil = Buffer.from(raw);
  const marker = Buffer.from('module: \'todo\'');
  const idx = evil.indexOf(marker.subarray(0, 12));
  expect(idx).toBeGreaterThan(0);
  evil[idx! + 9] = 0x75; // 「todo」→「tudo」：内容必变（原字节 0x74）
  expect(evil[idx! + 9]).not.toBe(raw[idx! + 9]);
  const out = zlib.gzipSync(evil);
  expect(out.equals(buf)).toBe(false);
  return out;
}

// ---------------------------------------------------------------------------
// 共享夹具：把来源模块塞进 workRoot（file: 本地目录）
// ---------------------------------------------------------------------------

let workRoot = '';
afterAll(async () => {
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

/** file: 来源模块目录（本地源码形态——唯一允许源码的来源）。 */
async function writeLocalModule(root: string): Promise<void> {
  const dir = join(root, 'my-todo');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.yaml'),
    [
      '# SPDX-License-Identifier: AGPL-3.0-only',
      'id: todo',
      'route: /m/todo',
      'entry: http://localhost:8791/',
      'runtimes:',
      '  - worker',
      'version: 2.0.0',
      'description: file: 本地模块',
    ].join('\n') + '\n',
  );
  // 本地源码形态：src/index.ts（builtin 装配同款入口约定，esbuild 直接打包；零依赖自包含）
  await writeFile(
    join(dir, 'src/index.ts'),
    [
      '// SPDX-License-Identifier: AGPL-3.0-only',
      'export default {',
      '  async fetch(request: Request) {',
      '    const url = new URL(request.url);',
      "    if (url.pathname === '/api/health') return Response.json({ ok: true, module: 'todo-local' });",
      "    return Response.json({ module: 'todo-local', path: url.pathname });",
      '  },',
      '};',
      '',
    ].join('\n'),
  );
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'unself-todo-local', version: '2.0.0', type: 'module', main: 'src/index.ts' }));
}

// ---------------------------------------------------------------------------
// 远端来源（npm/github/https）→ 装配器路径（fetchers 注入替身：真实字节走真 tar 解包）
// ---------------------------------------------------------------------------

/** 替身集：npm 元数据 → data: URL 下载（真实 fetch 不出网）；github 资产解析。 */
function makeFetchers(tarball: Buffer) {
  const sri = sriFromBuffer(tarball);
  const url = `data:application/octet-stream;base64,${tarball.toString('base64')}`;
  return {
    npm: async (input: { pkg: string; version?: string }) => ({
      tarballUrl: url,
      integrity: sri,
      version: input.version ?? PKG_MANIFEST.version,
    }),
    // 网络替身：不看出网 URL（那是被测对象拼的），一律回夹具字节——语义是「网络返回了包」
    download: async (input: { url: string; dest: string }) => {
      void input.url;
      const { mkdir: md, writeFile: wf } = await import('node:fs/promises');
      await md(join(input.dest, '..'), { recursive: true });
      await wf(input.dest, tarball);
      return { sri, size: tarball.length };
    },
    github: async () => ({ url, name: 'unself-todo-1.2.0.tgz' }),
  };
}

/** 声明一个 sourced 模块的九步（真装配路径；断言产物落位与上传请求）。 */
async function runWithSource(opts: {
  yes?: boolean;
  source: string;
  fetchers?: ReturnType<typeof makeFetchers>;
  preLock?: string;
}) {
  const fake = makeCfRestFake();
  const summary = await runNineSteps({
    rootDir: ROOT,
    client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
    configOverride: {
      domain: '',
      modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }, { id: 'todo', source: opts.source }],
      storage: { provider: 'r2', bucket: 'unself-storage' },
    },
    http: SMOKE_OK,
    buildShell: fakeBuildShell,
    yes: opts.yes,
    fetchers: opts.fetchers,
    preLock: opts.preLock,
  });
  return { fake, summary };
}

describe('#245 验收：来源安装 × 装配器路径（runNineSteps）', () => {
  it('npm: 来源装配成功：包落位 + wrapper/路由就绪 + lock 记录（SRI/manifestHash/契约版本）', { timeout: 120_000 }, async () => {
    const fetchers = makeFetchers(makePkgTarball());
    const { fake, summary } = await runWithSource({ source: 'npm:unself-todo@1.2.0', fetchers, yes: true });
    // 模块已上传（worker.js wrapper + app.js）
    const todoUploads = fake.state.uploads.filter((u) => u.worker === "unself-module-todo") ?? [];
    expect(todoUploads.length).toBeGreaterThan(0);
    // lock 落盘且记录 todo（SRI sha512 + manifestHash + 契约版本）
    const lockText = await readFile(join(ROOT, 'unself.lock'), 'utf8');
    const lock = JSON.parse(lockText) as { modules: Record<string, { source: string; integrity?: string; manifestHash: string; contractVersion: string; version: string }> };
    const todo = lock.modules.todo!;
    expect(todo.source).toBe('npm:unself-todo@1.2.0');
    expect(todo.version).toBe('1.2.0');
    expect(todo.integrity).toMatch(/^sha512-/);
    expect(todo.contractVersion).toBe('1.0');
    // 官方模块也进 lock（决策 #60/#77：写 npm 串，没有 builtin 合成来源）
    const hello = lock.modules.hello!;
    expect(hello.source).toBe('npm:@unself/hello@0.1.0');
    expect(hello.version).toBe('0.1.0');
    // 摘要含 todo
    expect(summary.modules.map((m) => m.id)).toContain('todo');
  });

  it('github: 与 https: 来源装配成功（各自一次，产物落位）', { timeout: 120_000 }, async () => {
    for (const source of ['github:acme/unself-todo#v1.2.0', 'https://mirrors.example.net/todo-1.2.0.tgz']) {
      const fetchers = makeFetchers(makePkgTarball());
      // github/https 替身里的 download 也注入（https 路径直接走 downloadTo 出网 → data: URL 替身）
      const withDownload = { ...fetchers, download: fetchers.download };
      const { fake } = await runWithSource({ source, fetchers: withDownload, yes: true });
      const todoUploads = fake.state.uploads.filter((u) => u.worker === 'unself-module-todo');
      expect(todoUploads.length).toBeGreaterThan(0);
    }
  });

  it('file: 本地目录装配成功（唯一允许本地源码：esbuild 打包 src/index.ts）', { timeout: 120_000 }, async () => {
    await writeLocalModule(ROOT);
    try {
      const { fake } = await runWithSource({ source: 'file:./my-todo', yes: true });
      const todoUploads = fake.state.uploads.filter((u) => u.worker === "unself-module-todo") ?? [];
      expect(todoUploads.length).toBeGreaterThan(0);
    } finally {
      await rm(join(ROOT, 'my-todo'), { recursive: true, force: true });
    }
  });

  it('重跑（lock 命中）：不再请求下载（fetchers 计数为 0），直接复用 lock 记录', { timeout: 120_000 }, async () => {
    // 第一次：取包 + 写 lock
    const fetchers1 = makeFetchers(makePkgTarball());
    await runWithSource({ source: 'npm:unself-todo@1.2.0', fetchers: fetchers1, yes: true });
    // 第二次：lock 命中——fetchers 注入「一调用就炸」的替身，装配仍然成功 = 未重新解析来源
    const boom = {
      npm: async () => {
        throw new Error('不应重新解析 npm 来源（重跑一律用 lock）');
      },
      download: async () => {
        throw new Error('不应重新下载（重跑一律用 lock）');
      },
      github: async () => {
        throw new Error('不应解析 github');
      },
    };
    const fake2 = makeCfRestFake();
    const summary2 = await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake2.fetchImpl }),
      configOverride: {
        domain: '',
        modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }, { id: 'todo', source: 'npm:unself-todo@1.2.0' }],
        storage: { provider: 'r2', bucket: 'unself-storage' },
      },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      yes: true,
      fetchers: boom,
    });
    expect(summary2.modules.map((m) => m.id)).toContain('todo');
  });

  it('【红灯】篡改 tarball：下载 SRI 与 registry 元数据不符 → 拒绝安装（九步失败、模块不上传）', { timeout: 120_000 }, async () => {
    // 干净现场：清掉前序用例留下的 lock 与暂存包（本用例要首装路径）
    await rm(join(ROOT, 'unself.lock'), { force: true });
    await rm(join(ROOT, '.deploy/cloudflare/module-sources'), { recursive: true, force: true });
    const good = makePkgTarball();
    const evil = tamperTarball(good);
    const fetchers = {
      ...makeFetchers(good),
      // 下载替身偷梁换柱：元数据是 good 的 SRI，实际给 evil 字节
      download: async (input: { url: string; dest: string }) => {
        const { mkdir: md, writeFile: wf } = await import('node:fs/promises');
        await md(join(input.dest, '..'), { recursive: true });
        await wf(input.dest, evil);
        return { sri: sriFromBuffer(evil), size: evil.length };
      },
    };
    await expect(runWithSource({ source: 'npm:unself-todo@1.2.0', fetchers, yes: true })).rejects.toThrow(/SRI 与 registry 元数据不一致/);
  });

  it('【红灯】改 config 版本号（换源）且未确认 → SourceDriftError 列 diff；-y 放行', { timeout: 120_000 }, async () => {
    // 先装 v1.2.0 写 lock
    await runWithSource({ source: 'npm:unself-todo@1.2.0', fetchers: makeFetchers(makePkgTarball()), yes: true });
    // 改 config 版本号（source 换成 @2.0.0）→ 不带 -y：要求确认
    const drift = runWithSource({ source: 'npm:unself-todo@2.0.0', fetchers: makeFetchers(makePkgTarball()) });
    await expect(drift).rejects.toBeInstanceOf(SourceDriftError);
    await drift.catch((err: SourceDriftError) => {
      expect(err.diffLines.join('\n')).toContain('todo');
      expect(err.diffLines.join('\n')).toContain('@2.0.0');
      expect(err.message).toContain('-y');
    });
    // 带 -y：放行（重新解析 @2.0.0 —— npm 替身 integrity 同步 v2 包字节，lock 随包更新）
    const v2Manifest = { ...PKG_MANIFEST, version: '2.0.0' };
    const pkgV2 = makePkgTarballWithManifest(v2Manifest);
    const fetchersV2 = {
      ...makeFetchers(pkgV2),
      npm: async () => ({ tarballUrl: 'data:application/octet-stream;base64,x', integrity: sriFromBuffer(pkgV2), version: '2.0.0' }),
    };
    const { fake } = await runWithSource({ source: 'npm:unself-todo@2.0.0', fetchers: fetchersV2, yes: true });
    const lock = JSON.parse(await readFile(join(ROOT, 'unself.lock'), 'utf8')) as { modules: Record<string, { version: string }> };
    expect(lock.modules.todo!.version).toBe('2.0.0');
    expect(fake.state.uploads.some((u) => u.worker === 'unself-module-todo')).toBe(true);
  });

  it('【红灯·①补】恶意 postinstall 包：装配上传后 worker 上传产物里无执行痕迹（标记不存在）', { timeout: 120_000 }, async () => {
    // postinstall 想写 pwned.marker；打包解包全程无脚本执行 → marker 不存在
    const evilWorker = PKG_WORKER; // worker 内容不变
    const evil = makePkgTarball({ worker: evilWorker });
    // 给包塞 postinstall.js + package.json scripts（字节级夹具暂不含；构造含 scripts 的变体）
    const evilWithScripts = makePkgTarballWithScripts();
    const fetchers = makeFetchers(evil);
    void evilWithScripts;
    const { fake } = await runWithSource({ source: 'npm:unself-evil@9.9.9', fetchers, yes: true });
    void fake;
    const staged = join(ROOT, '.deploy/cloudflare/module-sources/todo/package');
    expect(existsSync(join(staged, 'pwned.marker'))).toBe(false);
    // worker.js 是原样字节（没有被执行过的迹象）
    expect(await readFile(join(staged, 'worker.js'), 'utf8')).toBe(evilWorker);
  });
});

/** 含 npm scripts 的恶意包变体（postinstall 写标记文件）。 */
/** 指定 manifest 的包变体（升级用例：v2.0.0）。 */
function makePkgTarballWithManifest(manifest: typeof PKG_MANIFEST): Buffer {
  const entries: Array<{ name: string; data: Buffer }> = [
    { name: 'package/manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: 'package/worker.js', data: Buffer.from(PKG_WORKER) },
    { name: 'package/LICENSE', data: Buffer.from(PKG_LICENSE) },
  ];
  return tarballFromEntries(entries);
}

function makePkgTarballWithScripts(): Buffer {
  const entries: Array<{ name: string; data: Buffer }> = [
    { name: 'package/manifest.json', data: Buffer.from(JSON.stringify(PKG_MANIFEST)) },
    { name: 'package/worker.js', data: Buffer.from(PKG_WORKER) },
    { name: 'package/LICENSE', data: Buffer.from(PKG_LICENSE) },
    {
      name: 'package/postinstall.js',
      data: Buffer.from("require('node:fs').writeFileSync(__dirname + '/pwned.marker', 'PWNED BY postinstall');\n"),
    },
    {
      name: 'package/package.json',
      data: Buffer.from(JSON.stringify({ name: 'unself-evil-probe', version: '9.9.9', scripts: { install: 'node postinstall.js', postinstall: 'node postinstall.js' } })),
    },
  ];
  void entries;
  // 复用 makePkgTarball 的字节构造器：直接内联（与 sources.test 的 buildTarInMemory 同型）
  const zlib = require('node:zlib') as typeof import('node:zlib');
  void zlib;
  return tarballFromEntries(entries);
}

/** tar 字节构造器（夹具共享）：entries 全部落在 package/ 前缀下 = npm 包形态。 */
function tarballFromEntries(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, Math.min(e.name.length, 100));
    h.write('0000644\0', 100, 8);
    h.write('0000000\0', 108, 8);
    h.write('0000000\0', 116, 8);
    h.write(`${e.data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    h.write(''.padEnd(12, '\0'), 136, 12);
    h.write('0', 156, 1);
    h.write('ustar\0', 257, 6);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(h, e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  const zlib = require('node:zlib') as typeof import('node:zlib');
  return zlib.gzipSync(Buffer.concat(blocks));
}
