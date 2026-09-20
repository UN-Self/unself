// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 资源命名测试（#257）：`UNSELF_RESOURCE_PREFIX` 让同一个 CF 账户能起第二套实例（隔离探针用）。
 * 默认空前缀 = 既有生产命名逐字不变（回归由既有 300+ 用例覆盖）；这里测「有前缀」与「非法前缀」。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coreDbName, coreWorkerName, modulesDbName, moduleWorkerName, resourceName } from '../../src/engine/naming';
import { runNineSteps } from '../../src/engine/steps';
import { RestClient } from '../../src/engine/rest/client';
import { makeCfRestFake } from './helpers/cf-rest-fake';
import { writeArtifactFixture } from './helpers/artifacts-fixture';

const ENV_KEY = 'UNSELF_RESOURCE_PREFIX';
const saved = process.env[ENV_KEY];

beforeEach(() => {
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe('resourceName（空前缀 = 现状；有前缀 = 同账户第二套）', () => {
  it('空前缀：与既有生产名逐字一致', () => {
    expect(resourceName('core')).toBe('unself-core');
    expect(coreDbName()).toBe('unself-core');
    expect(modulesDbName()).toBe('unself-modules');
    expect(coreWorkerName()).toBe('unself-core-api');
    expect(moduleWorkerName('hello')).toBe('unself-module-hello');
  });

  it('前缀：资源名整体换命名空间（含 service binding 目标）', () => {
    process.env[ENV_KEY] = 'unself-probe-257-';
    expect(coreDbName()).toBe('unself-probe-257-core');
    expect(modulesDbName()).toBe('unself-probe-257-modules');
    expect(coreWorkerName()).toBe('unself-probe-257-core-api');
    expect(moduleWorkerName('chat')).toBe('unself-probe-257-module-chat');
  });

  it('非法前缀（不以 - 结尾/大写/空串）：抛人话错，不拼出半个实例名', () => {
    for (const bad of ['unself-probe-257', 'Unself-', '-x-', 'unself probe-']) {
      process.env[ENV_KEY] = bad;
      expect(() => resourceName('core')).toThrow(/不合法/);
    }
    process.env[ENV_KEY] = '';
    expect(resourceName('core')).toBe('unself-core'); // 空串 = 空前缀（部署脚本 export 空值场景）
  });
});

describe('带前缀的九步（隔离探针口径）', () => {
  it('D1 / Worker / service 绑定全部带前缀（与线上 unself-* 不重叠）', { timeout: 120_000 }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'unself-name-root-'));
    const artifacts = await mkdtemp(join(tmpdir(), 'unself-name-arts-'));
    try {
      await writeArtifactFixture(artifacts);
      process.env[ENV_KEY] = 'unself-probe-257-';
      const fake = makeCfRestFake();
      await runNineSteps({
        rootDir,
        artifactRoot: artifacts,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-probe-257-storage' } },
        http: {
          smoke: async (b: string, mods: Array<{ id: string; baseUrl: string }>) =>
            [{ name: 'core-api', url: `${b}/api/health`, ok: true, status: 200 }].concat(
              mods.map((m) => ({ name: `module:${m.id}`, url: `${m.baseUrl}/api/health`, ok: true, status: 200 })),
            ),
        },
      });
      // 资源名全部带前缀：线上 unself-core / unself-core-api 一个都不会被撞
      expect([...fake.state.d1.keys()].sort()).toEqual(['unself-probe-257-core', 'unself-probe-257-modules']);
      expect(fake.state.uploads.some((u) => u.worker === 'unself-probe-257-core-api')).toBe(true);
      expect(fake.state.uploads.some((u) => u.worker === 'unself-probe-257-module-hello')).toBe(true);
      expect(fake.state.uploads.some((u) => u.worker.startsWith('unself-module-'))).toBe(false);
      // core 级模块的 CORE_API service binding 指向同前缀 core worker（否则绑定悬空）
      const coreUpload = fake.state.uploads.find((u) => u.worker === 'unself-probe-257-core-api');
      expect(coreUpload).toBeDefined();
      const modUpload = fake.state.uploads.find((u) => u.worker === 'unself-probe-257-module-hello');
      const bindings = (modUpload!.metadata.bindings ?? []) as Array<{ type: string; service?: string }>;
      expect(bindings.find((b) => b.type === 'service')?.service).toBe('unself-probe-257-core-api');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
      await rm(artifacts, { recursive: true, force: true });
    }
  });
});
