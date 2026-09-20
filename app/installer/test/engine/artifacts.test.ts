// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 平台产物解析与装配行为测试（#303 修订 #257 口径）：
 * 产物**随 `@unself/workbench` 包发布**，引擎只当消费者——不再有「安装器内嵌 artifacts / 仓库形态读源码树」
 * 两套行为，仓库开发与 npm 安装**同源**。
 *
 * 取证方式（硬）：rootDir 是**空目录**（没有 app/modules、app/workbench 源码树），
 * 冒充 workbench 的包目录是**从零合成**的——九步能跑通即证明「没读仓库」：真去读会因文件不存在炸掉。
 * 反向（红灯）：包目录指到空目录必须抛错——否则会静默回落成仓库路径，
 * 干净机器上就变成「看起来在读产物、其实在读不存在的源码树」。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePlatformArtifacts, WORKBENCH_PACKAGE } from '../../src/engine/artifacts';
import { runNineSteps } from '../../src/engine/steps';
import { RestClient } from '../../src/engine/rest/client';
import { makeCfRestFake } from './helpers/cf-rest-fake';
import { FAKE_CORE_WORKER, writeWorkbenchFixture } from './helpers/workbench-fixture';

const SMOKE_OK = {
  smoke: async (b: string, mods: Array<{ id: string; baseUrl: string }>) =>
    [{ name: 'core-api', url: `${b}/api/health`, ok: true, status: 200 }].concat(
      mods.map((m) => ({ name: `module:${m.id}`, url: `${m.baseUrl}/api/health`, ok: true, status: 200 })),
    ),
};

const tmps: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmps.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmps.length > 0) await rm(tmps.pop()!, { recursive: true, force: true });
});

describe('resolvePlatformArtifacts（平台产物解析：显式目录 > 包解析）', () => {
  it('显式目录必须是 workbench 包：空目录 / 同名错包 → 抛错（不静默回落）', async () => {
    const empty = await tmp('unself-wb-empty-');
    expect(() => resolvePlatformArtifacts({ rootDir: empty, workbenchDir: empty })).toThrow(/平台产物不可用/);
    expect(() => resolvePlatformArtifacts({ rootDir: empty, workbenchDir: join(empty, 'nope') })).toThrow(
      /平台产物不可用/,
    );
    // 目录里有 package.json 但名字不对（防「指错包」）
    await writeFile(join(empty, 'package.json'), JSON.stringify({ name: '@unself/other', version: '1.0.0' }));
    expect(() => resolvePlatformArtifacts({ rootDir: empty, workbenchDir: empty })).toThrow(/不是 @unself\/workbench 包/);
  });

  it('包已装但没构建（缺 dist/worker.js）→ 抛人话错（指出怎么构建）', async () => {
    const dir = await tmp('unself-wb-nobuild-');
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: WORKBENCH_PACKAGE, version: '0.1.0' }));
    expect(() => resolvePlatformArtifacts({ rootDir: dir, workbenchDir: dir })).toThrow(/dist\/worker\.js/);
  });

  it('缺壳产物 / 缺迁移 SQL → 各自抛错（半套产物不算产物）', async () => {
    const noShell = await tmp('unself-wb-noshell-');
    await writeWorkbenchFixture(noShell);
    await rm(join(noShell, 'dist', 'web'), { recursive: true, force: true });
    expect(() => resolvePlatformArtifacts({ rootDir: noShell, workbenchDir: noShell })).toThrow(/index\.html/);

    const noMig = await tmp('unself-wb-nomig-');
    await writeWorkbenchFixture(noMig);
    await rm(join(noMig, 'migrations', 'core'), { recursive: true, force: true });
    expect(() => resolvePlatformArtifacts({ rootDir: noMig, workbenchDir: noMig })).toThrow(/migrations\/core/);
  });

  it('合法包 → 子路径齐备、版本取自 package.json；env 变量同样生效', async () => {
    const dir = await tmp('unself-wb-ok-');
    await writeWorkbenchFixture(dir, { version: '9.9.9-test' });
    const arts = resolvePlatformArtifacts({ rootDir: dir, workbenchDir: dir });
    expect(arts.root).toBe(dir);
    expect(arts.version).toBe('9.9.9-test');
    expect(arts.coreWorker).toBe(join(dir, 'dist', 'worker.js'));
    expect(arts.shellDir).toBe(join(dir, 'dist', 'web'));
    expect(arts.coreMigrationsDir).toBe(join(dir, 'migrations', 'core'));
    expect(arts.platformMigrationsDir).toBe(join(dir, 'migrations', 'modules'));

    const viaEnv = resolvePlatformArtifacts({ rootDir: dir, env: { UNSELF_WORKBENCH_DIR: dir } });
    expect(viaEnv.root).toBe(dir);
  });

  it('缺省从 node_modules 解析（安装器依赖 → 装上即可用）', async () => {
    const rootDir = await tmp('unself-wb-root-');
    const installed = join(rootDir, 'node_modules', '@unself', 'workbench');
    await mkdir(join(installed, 'dist'), { recursive: true });
    await writeWorkbenchFixture(installed, { version: '0.2.0' });
    const arts = resolvePlatformArtifacts({ rootDir });
    expect(arts.root).toBe(installed);
    expect(arts.version).toBe('0.2.0');
    // 注：解析基准是 rootDir → 引擎目录 → cwd（localPackageDir 三处兜底，#284），
    // 所以「仓库里根本找不到包」这种场景不在真实路径上——找不到包时的人话错由显式目录那条用例覆盖。
  });
});

describe('runNineSteps（平台产物形态：空 rootDir 也能装配出实例）', () => {
  it('空 rootDir + 合成 workbench 包：九步跑通，core / 壳 / 模块 worker 全部来自包内产物', { timeout: 120_000 }, async () => {
    const rootDir = await tmp('unself-wb-rootdir-'); // 空目录：无 app/modules、app/workbench
    const wb = await tmp('unself-wb-pkg-');
    await writeWorkbenchFixture(wb);
    const fake = makeCfRestFake();
    let repoBuildCalled = false;

    const summary = await runNineSteps({
      rootDir,
      workbenchDir: wb,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: {
        domain: '',
        modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }],
        storage: { provider: 'r2', bucket: 'unself-storage' },
      },
      http: SMOKE_OK,
      // 产物形态**不得**触发仓库内构建；一旦触发即测试失败（干净机器没有 pnpm/vite）
      buildChatFrontend: async () => {
        throw new Error('未选 chat：不应触发前端构建');
      },
    });
    void repoBuildCalled;

    expect(summary.baseUrl).toBe('https://unself-workbench.test-subdomain.workers.dev');
    // core Worker 来自包内产物（字节级一致）
    expect(await readFile(join(rootDir, '.deploy/cloudflare/core-worker.js'), 'utf8')).toBe(FAKE_CORE_WORKER);
    // 壳资产来自包内产物
    expect(await readFile(join(rootDir, '.deploy/cloudflare/assets/shell/index.html'), 'utf8')).toContain(
      'FIXTURE SHELL',
    );
    // SDK 浏览器资产来自 @unself/sdk 包（#284：不再是产物里的副本）
    expect(existsSync(join(rootDir, '.deploy/cloudflare/modules/hello/assets/sdk/module-sdk.esm.js'))).toBe(true);
    // 官方模块是普通 npm 包：注册表快照里的 version 来自本地命中的包
    const hello = fake.state.registry.get('hello');
    expect(hello?.enabled).toBe(1);
    expect(JSON.parse(hello!.manifest_json).version).toBe('0.1.0');
    // 模块 worker 上传（源码形态 → 装配期 esbuild 打包）
    const upload = fake.state.uploads.find((u) => u.worker === 'unself-module-hello');
    expect(upload).toBeDefined();
    expect(fake.state.d1.has('unself-core')).toBe(true);
    expect(fake.state.d1.has('unself-modules')).toBe(true);
  });

  it('选中模块的来源解析不了 → 人话失败且不创建任何 CF 资源（不是静默跳过）', { timeout: 120_000 }, async () => {
    const rootDir = await tmp('unself-wb-rootdir2-');
    const wb = await tmp('unself-wb-pkg2-');
    await writeWorkbenchFixture(wb);
    const fake = makeCfRestFake();
    await expect(
      runNineSteps({
        rootDir,
        workbenchDir: wb,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        yes: true,
        configOverride: {
          domain: '',
          modules: [{ id: 'ghost', source: 'file:./app/modules/ghost' }],
          storage: { provider: 'r2', bucket: 'unself-storage' },
        },
        http: SMOKE_OK,
      }),
    ).rejects.toThrow(/ghost/);
    // 来源解析在步骤①之前 → 一个 D1 都没建（fail before side effect）
    expect(fake.state.d1.size).toBe(0);
  });

  it('包目录指到空目录 → 红（证明「真在读包内产物」，不是碰巧没读）', { timeout: 60_000 }, async () => {
    const rootDir = await tmp('unself-wb-rootdir3-');
    const empty = await tmp('unself-wb-empty3-');
    const fake = makeCfRestFake();
    await expect(
      runNineSteps({
        rootDir,
        workbenchDir: empty,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        yes: true,
        configOverride: {
          domain: '',
          modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }],
          storage: { provider: 'r2', bucket: 'unself-storage' },
        },
        http: SMOKE_OK,
      }),
    ).rejects.toThrow(/平台产物不可用/);
  });

  it('#284：SDK 浏览器资产从 @unself/sdk 包解析（产物里没有 sdk/ 副本）', async () => {
    const rootDir = await tmp('unself-wb-rootdir4-');
    const wb = await tmp('unself-wb-pkg4-');
    await writeWorkbenchFixture(wb);
    expect(existsSync(join(wb, 'sdk'))).toBe(false);
    const { resolveSdkAssetsDir } = await import('../../src/engine/assemble');
    const sdkDir = resolveSdkAssetsDir(rootDir);
    expect(sdkDir).toContain(join('node_modules', '@unself', 'sdk', 'dist'));
    expect(existsSync(join(sdkDir, 'module-sdk.esm.js'))).toBe(true);
  });
});
