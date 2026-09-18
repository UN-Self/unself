// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 产物模式行为测试（#257）：引擎从「随安装器分发的产物根」装配，而不是从 rootDir 读仓库源码树。
 *
 * 取证方式（硬）：rootDir 是一个**空目录**（没有 modules/ services/ apps/ packages/），
 * 产物根是**从零合成**的字典树——九步能跑通即证明「没读仓库」：真去读会因文件不存在炸掉。
 * 反向（红灯）：把产物根指到空目录必须抛错——否则「产物模式」会静默回落成仓库路径，
 * 干净机器上就变成「看起来在跑产物、其实在读不存在的源码树」。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveArtifactRoots } from '../src/artifacts';
import { runNineSteps } from '../src/steps';
import { RestClient } from '../src/rest/client';
import { makeCfRestFake } from './helpers/cf-rest-fake';
import { FAKE_CORE_WORKER, writeArtifactFixture } from './helpers/artifacts-fixture';

const SMOKE_OK = {
  smoke: async (b: string, ids: string[]) =>
    [{ name: 'core-api', url: `${b}/api/health`, ok: true, status: 200 }].concat(
      ids.map((id) => ({ name: `module:${id}`, url: `${b}/m/${id}/api/health`, ok: true, status: 200 })),
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

describe('resolveArtifactRoots（产物根解析，显式 > env > 自探测）', () => {
  it('显式路径必须合法：空目录/无 manifest.json → 抛错（不静默回落仓库形态）', async () => {
    const empty = await tmp('unself-arts-empty-');
    expect(() => resolveArtifactRoots({ artifactRoot: empty })).toThrow(/产物根不合法/);
    expect(() => resolveArtifactRoots({ artifactRoot: join(empty, 'nope') })).toThrow(/产物根不合法/);
  });

  it('formatVersion 不符 → 抛错（引擎与产物必须同版本发布）', async () => {
    const root = await tmp('unself-arts-ver-');
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ formatVersion: 999 }));
    expect(() => resolveArtifactRoots({ artifactRoot: root })).toThrow(/版本不兼容/);
  });

  it('合法产物根 → 子路径齐备；env 变量同样生效', async () => {
    const root = await tmp('unself-arts-ok-');
    await writeArtifactFixture(root);
    const roots = resolveArtifactRoots({ artifactRoot: root });
    expect(roots?.coreWorker).toBe(join(root, 'core', 'worker.js'));
    expect(roots?.modulesDir).toBe(join(root, 'modules'));
    expect(roots?.shellDir).toBe(join(root, 'shell'));
    const viaEnv = resolveArtifactRoots({ env: { UNSELF_ARTIFACTS: root } });
    expect(viaEnv?.root).toBe(roots?.root);
  });

  it('自探测：引擎源码目录旁无 artifacts/ → null（仓库开发形态，零回归）', () => {
    // vitest 下 import.meta.url 指向 src/artifacts.ts → src/artifacts/ 不存在
    expect(resolveArtifactRoots({ env: {} })).toBeNull();
  });
});

describe('runNineSteps（产物模式：空 rootDir 也能装配出实例）', () => {
  it('空 rootDir + 合成产物根：九步跑通，core/shell/模块 worker 全部来自产物', { timeout: 120_000 }, async () => {
    const rootDir = await tmp('unself-arts-rootdir-'); // 空目录：无 modules/ services/ apps/
    const artifacts = await tmp('unself-arts-tree-');
    await writeArtifactFixture(artifacts);
    const fake = makeCfRestFake();
    let shellBuildCalled = false;

    const summary = await runNineSteps({
      rootDir,
      artifactRoot: artifacts,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      configOverride: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      // 产物模式**不得**触发仓库构建；一旦触发即测试失败（干净机器没有 pnpm/vite）
      buildShell: async () => {
        shellBuildCalled = true;
        throw new Error('产物模式下不应调用 shell 构建（干净机器没有 pnpm/vite）');
      },
      buildChatFrontend: async () => {
        throw new Error('未选 chat：不应触发前端构建');
      },
    });

    expect(shellBuildCalled).toBe(false);
    expect(summary.baseUrl).toBe('https://unself-core-api.test-subdomain.workers.dev');
    // core Worker 来自产物（字节级一致）
    expect(await readFile(join(rootDir, '.deploy/cloudflare/core-worker.js'), 'utf8')).toBe(FAKE_CORE_WORKER);
    // shell 资产来自产物
    expect(await readFile(join(rootDir, '.deploy/cloudflare/assets/shell/index.html'), 'utf8')).toContain('FIXTURE SHELL');
    // SDK 浏览器资产来自产物
    expect(existsSync(join(rootDir, '.deploy/cloudflare/modules/hello/assets/sdk/module-sdk.esm.js'))).toBe(true);
    // builtin 模块以「包」被消费：注册表快照里的 version 来自产物 manifest（9.9.9，不是仓库里的 0.1.0）
    const hello = fake.state.registry.get('hello');
    expect(hello?.enabled).toBe(1);
    expect(JSON.parse(hello!.manifest_json).version).toBe('9.9.9');
    // 模块 worker 上传内容来自产物
    const upload = fake.state.uploads.find((u) => u.worker === 'unself-module-hello');
    expect(upload).toBeDefined();
    // 产物里缺失的选中模块 → 明确失败（不静默半套）
    expect(fake.state.d1.has('unself-core')).toBe(true);
    expect(fake.state.d1.has('unself-modules')).toBe(true);
  });

  it('产物里没有选中模块 → 人话失败（不是静默跳过）', { timeout: 120_000 }, async () => {
    const rootDir = await tmp('unself-arts-rootdir2-');
    const artifacts = await tmp('unself-arts-tree2-');
    await writeArtifactFixture(artifacts); // 只有 hello
    const fake = makeCfRestFake();
    await expect(
      runNineSteps({
        rootDir,
        artifactRoot: artifacts,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        configOverride: { domain: '', modules: ['ghost'], storage: { provider: 'r2', bucket: 'unself-storage' } },
        http: SMOKE_OK,
      }),
    ).rejects.toThrow(/ghost/);
  });

  it('产物根指到空目录 → 红（证明「真在读产物」，不是碰巧没读）', { timeout: 60_000 }, async () => {
    const rootDir = await tmp('unself-arts-rootdir3-');
    const empty = await tmp('unself-arts-empty3-');
    const fake = makeCfRestFake();
    await expect(
      runNineSteps({
        rootDir,
        artifactRoot: empty,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        configOverride: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
        http: SMOKE_OK,
      }),
    ).rejects.toThrow(/产物根不合法/);
  });

  it('缺 SDK 资产的残缺产物 → 人话失败（不产出半套实例）', { timeout: 60_000 }, async () => {
    const rootDir = await tmp('unself-arts-rootdir4-');
    const artifacts = await tmp('unself-arts-tree4-');
    await writeArtifactFixture(artifacts);
    await rm(join(artifacts, 'sdk'), { recursive: true, force: true });
    const fake = makeCfRestFake();
    await expect(
      runNineSteps({
        rootDir,
        artifactRoot: artifacts,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        configOverride: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
        http: SMOKE_OK,
      }),
    ).rejects.toThrow(/产物不完整/);
  });
});
