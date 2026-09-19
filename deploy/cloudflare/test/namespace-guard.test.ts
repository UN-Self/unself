// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #272：实例命名空间 + 撞车守卫行为测试。
 *
 * 覆盖验收：
 * - 两实例共存（同一 CF 账户，A/B 命名空间资源名不相交，B 不写 A 的资源）；
 * - 撞车守卫拦住（台账证明不了归属 → 停住列资源；`allowAdopt` 才继续）；
 * - 既有实例零影响（无 namespace 的历史配置 → 资源名逐字不变；命名空间状态不泄漏）；
 * - R2 桶名纳入命名空间（parse 派生 + 真跑建桶）；
 * - 守卫不是无脑拦（本实例幂等重跑：台账对上 → 放行）。
 *
 * 红灯（缺一不可，见报告）：
 * - 命名空间派生改回常量 → 「两实例共存」红；
 * - 守卫改静默继续 → 「守卫拦住」红；
 * - 守卫恒停（连自家资源也拒）→ 「幂等重跑放行」红。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runNineSteps } from '../src/steps';
import { RestClient } from '../src/rest/client';
import { makeCfRestFake } from './helpers/cf-rest-fake';
import { writeArtifactFixture } from './helpers/artifacts-fixture';
import { parseUnselfConfigText, withNamespacedBucket } from '../src/config';
import {
  activeResourceNamespace,
  coreDbName,
  coreWorkerName,
  modulesDbName,
  previewResourceNames,
  resourceName,
  resourceNameFor,
  setResourceNamespace,
} from '../src/naming';
import { ResourceCollisionError, decideGuard, targetResources } from '../src/guard';

const FIXED_JWKS = JSON.stringify({
  keys: [{
    kty: 'EC',
    crv: 'P-256',
    x: '2zYTVcy0bDXQ7qqeNDB38zsPVvwUkKZ6-m3xA1zwA2U',
    y: 'j8zUPxAyGRUAaHRNYwdU3IW7TSBI1kSrg7RmUhb8lZk',
    kid: 'RDB_5KqpPvLCvU7V6n8r6-xxpSJutKJCWNmyZWesNSg',
    use: 'sig',
    alg: 'ES256',
  }],
});

const SMOKE_OK = {
  smoke: async (b: string, mods: Array<{ id: string; baseUrl: string }>) =>
    ([{ name: 'core-api', url: `${b}/api/health`, ok: true, status: 200 }] as Array<{
      name: string;
      url: string;
      ok: boolean;
      status: number;
    }>).concat(mods.map((m) => ({ name: `module:${m.id}`, url: `${m.baseUrl}/api/health`, ok: true, status: 200 }))),
};

const temps: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  setResourceNamespace(undefined);
  delete process.env.UNSELF_RESOURCE_PREFIX;
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('#272 配置命名空间（纯函数）', () => {
  it('配了 namespace 且未显式写桶名 → 桶名跟随命名空间；无 namespace → 历史桶名逐字不变', () => {
    const ns = parseUnselfConfigText('{"namespace":"mysite","modules":[{"id":"hello","source":"npm:@unself/hello@0.1.0"}],"storage":{"provider":"r2"}}');
    expect(ns.namespace).toBe('mysite');
    expect(ns.storage).toEqual({ provider: 'r2', bucket: 'mysite-storage' });

    const legacy = parseUnselfConfigText('{"modules":[{"id":"hello","source":"npm:@unself/hello@0.1.0"}],"storage":{"provider":"r2"}}');
    expect(legacy.namespace).toBeUndefined();
    expect(legacy.storage).toEqual({ provider: 'r2', bucket: 'unself-storage' });
  });

  it('显式桶名不被命名空间覆盖；s3 不受影响', () => {
    const explicit = parseUnselfConfigText(
      '{"namespace":"mysite","modules":[],"storage":{"provider":"r2","bucket":"my-own-bucket"}}',
    );
    expect(explicit.storage).toEqual({ provider: 'r2', bucket: 'my-own-bucket' });
    const s3 = parseUnselfConfigText(
      '{"namespace":"mysite","modules":[],"storage":{"provider":"s3","endpoint":"https://s3.example","bucket":"b"}}',
    );
    expect(s3.storage.provider).toBe('s3');
  });

  it('非法命名空间直接拒绝（拼歪会造半套实例）', () => {
    expect(() => parseUnselfConfigText('{"namespace":"My Site","modules":[]}')).toThrow();
    expect(() => parseUnselfConfigText('{"namespace":"-x-","modules":[]}')).toThrow();
  });

  it('resourceNameFor / previewResourceNames 派生规则与命名空间同源', () => {
    expect(resourceNameFor('mysite', 'core')).toBe('mysite-core');
    expect(resourceNameFor(undefined, 'core')).toBe('unself-core');
    const names = previewResourceNames({ namespace: 'mysite', moduleIds: ['hello'], bucket: 'mysite-storage' }).map(
      (n) => n.name,
    );
    expect(names).toContain('mysite-core');
    expect(names).toContain('mysite-core-api');
    expect(names).toContain('mysite-module-hello');
    expect(names).toContain('mysite-storage');
    expect(names).not.toContain('unself-core');
  });

  it('UNSELF_RESOURCE_PREFIX 仍可显式覆盖登记的命名空间（探针/CI）', () => {
    setResourceNamespace('mysite');
    expect(resourceName('core')).toBe('mysite-core');
    process.env.UNSELF_RESOURCE_PREFIX = 'unself-probe-272-';
    expect(resourceName('core')).toBe('unself-probe-272-core');
    delete process.env.UNSELF_RESOURCE_PREFIX;
    expect(resourceName('core')).toBe('mysite-core');
    setResourceNamespace(undefined);
    expect(coreDbName()).toBe('unself-core');
  });
});

describe('#272 撞车守卫（纯逻辑）', () => {
  const targets = targetResources({
    prefix: 'sitea-',
    moduleIds: ['hello'],
    bucket: 'sitea-storage',
    chatSelected: false,
  });

  it('目标名只列本次会创建/绑定的资源（含桶与模块 Worker）', () => {
    expect(targets.map((t) => `${t.kind}:${t.name}`).sort()).toEqual(
      ['d1:sitea-core', 'd1:sitea-modules', 'r2:sitea-storage', 'worker:sitea-core-api', 'worker:sitea-module-hello'].sort(),
    );
  });

  it('无同名资源 → clear；台账对上 → owned；对不上 → 停住；allowAdopt → adopted', () => {
    const existing = [
      { kind: 'd1' as const, name: 'sitea-core', id: 'uuid-1' },
      { kind: 'worker' as const, name: 'sitea-core-api' },
    ];
    expect(decideGuard({ existing: [], allowAdopt: false }).status).toBe('clear');

    const ledger = {
      d1: [{ name: 'sitea-core', id: 'uuid-1' }],
      kv: [],
      r2: [],
      workers: [{ name: 'sitea-core-api' }],
    };
    expect(decideGuard({ existing, ledger, allowAdopt: false }).status).toBe('owned');

    // 台账 id 对不上（别人换过库）→ 停住
    expect(() =>
      decideGuard({ existing, ledger: { ...ledger, d1: [{ name: 'sitea-core', id: 'uuid-OTHER' }] }, allowAdopt: false }),
    ).toThrow(ResourceCollisionError);

    const adopted = decideGuard({ existing, allowAdopt: true });
    expect(adopted.status).toBe('adopted');
    expect(adopted.foreign.map((f) => f.name).sort()).toEqual(['sitea-core', 'sitea-core-api']);

    // 停住原文含资源名与继续方式
    try {
      decideGuard({ existing, allowAdopt: false, allowHint: '加 --allow-adopt' });
      expect.unreachable('应停住');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('撞车守卫');
      expect(msg).toContain('sitea-core');
      expect(msg).toContain('--allow-adopt');
    }
  });
});

describe('#272 九步真跑（替身账户）', () => {
  it('两实例共存：同一账户 A/B 命名空间资源名不相交，B 不写 A 的 D1/Worker/桶', { timeout: 120_000 }, async () => {
    const artA = await tmp('unself-272-artA-');
    const rootA = await tmp('unself-272-rootA-');
    const artB = await tmp('unself-272-artB-');
    const rootB = await tmp('unself-272-rootB-');
    await writeArtifactFixture(artA);
    await writeArtifactFixture(artB);
    const account = makeCfRestFake(); // 同一个 CF 账户

    await runNineSteps({
      rootDir: rootA,
      artifactRoot: artA,
      client: new RestClient({ token: 't', fetchImpl: account.fetchImpl }),
      yes: true,
      configOverride: {
        domain: '',
        namespace: 'sitea',
        modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }],
        storage: { provider: 'r2', bucket: 'sitea-storage' },
      },
      http: SMOKE_OK,
    });
    const afterA = account.calls.length;

    await runNineSteps({
      rootDir: rootB,
      artifactRoot: artB,
      client: new RestClient({ token: 't', fetchImpl: account.fetchImpl }),
      yes: true,
      configOverride: {
        domain: '',
        namespace: 'siteb',
        modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }],
        storage: { provider: 'r2', bucket: 'siteb-storage' },
      },
      http: SMOKE_OK,
    });
    const bCalls = account.calls.slice(afterA);

    // 两边资源名不同、都在账户里
    expect([...account.state.d1.keys()].sort()).toEqual(['sitea-core', 'sitea-modules', 'siteb-core', 'siteb-modules']);
    expect([...account.state.buckets].sort()).toEqual(['sitea-storage', 'siteb-storage']);
    expect(account.state.d1.get('sitea-core')).toBeDefined(); // A 的 D1 仍在（未被 B 顶掉）
    // B 全程没有创建/覆盖任何 sitea-* 资源
    expect(
      bCalls.some(
        (c) => c.method === 'POST' && c.url.endsWith('/d1/database') && (c.body as { name: string }).name.startsWith('sitea-'),
      ),
    ).toBe(false);
    expect(bCalls.some((c) => c.method === 'PUT' && c.url.includes('/workers/scripts/sitea-'))).toBe(false);
    expect(
      bCalls.some(
        (c) => c.method === 'POST' && c.url.endsWith('/r2/buckets') && (c.body as { name: string }).name === 'sitea-storage',
      ),
    ).toBe(false);
    // 命名空间状态不泄漏：运行结束回到历史形态
    expect(activeResourceNamespace()).toBeUndefined();
    expect(coreDbName()).toBe('unself-core');
  });

  it('撞车守卫拦住：B 的命名空间指向 A → 停住列资源；allowAdopt 才继续', { timeout: 120_000 }, async () => {
    const artA = await tmp('unself-272-artA2-');
    const rootA = await tmp('unself-272-rootA2-');
    await writeArtifactFixture(artA);
    const account = makeCfRestFake();
    await runNineSteps({
      rootDir: rootA,
      artifactRoot: artA,
      client: new RestClient({ token: 't', fetchImpl: account.fetchImpl }),
      yes: true,
      configOverride: {
        domain: '',
        namespace: 'sitea',
        modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }],
        storage: { provider: 'r2', bucket: 'sitea-storage' },
      },
      http: SMOKE_OK,
    });

    // B：全新实例目录，却把命名空间指成 A 的 → 台账在 B 手里不存在 → 停住
    const artB = await tmp('unself-272-artB2-');
    const rootB = await tmp('unself-272-rootB2-');
    await writeArtifactFixture(artB);
    let caught: unknown;
    try {
      await runNineSteps({
        rootDir: rootB,
        artifactRoot: artB,
        client: new RestClient({ token: 't', fetchImpl: account.fetchImpl }),
        yes: true,
      configOverride: {
          domain: '',
          namespace: 'sitea',
          modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }],
          storage: { provider: 'r2', bucket: 'sitea-storage' },
        },
        http: SMOKE_OK,
      });
      expect.unreachable('应被撞车守卫拦住');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResourceCollisionError);
    const msg = (caught as Error).message;
    expect(msg).toContain('撞车守卫');
    expect(msg).toContain('sitea-core');
    expect(msg).toContain('sitea-storage');
    // 停住时未创建任何资源（D1 集合仍是 A 的那两个）
    expect([...account.state.d1.keys()].sort()).toEqual(['sitea-core', 'sitea-modules']);

    // 显式开关才继续
    await runNineSteps({
      rootDir: rootB,
      artifactRoot: artB,
      client: new RestClient({ token: 't', fetchImpl: account.fetchImpl }),
      yes: true,
      configOverride: {
        domain: '',
        namespace: 'sitea',
        modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }],
        storage: { provider: 'r2', bucket: 'sitea-storage' },
      },
      http: SMOKE_OK,
      fetchJwks: async () => FIXED_JWKS,
      allowAdopt: true,
    });
  });

  it('守卫不是无脑拦：本实例幂等重跑（台账对上）无需开关即放行', { timeout: 120_000 }, async () => {
    const art = await tmp('unself-272-artR-');
    const root = await tmp('unself-272-rootR-');
    await writeArtifactFixture(art);
    const account = makeCfRestFake();
    const cfg = {
      domain: '',
      namespace: 'sited',
      modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }],
      storage: { provider: 'r2' as const, bucket: 'sited-storage' },
    };
    await runNineSteps({
      rootDir: root,
      artifactRoot: art,
      client: new RestClient({ token: 't', fetchImpl: account.fetchImpl }),
      yes: true,
      configOverride: cfg,
      http: SMOKE_OK,
    });
    // 二跑：同一实例目录（unself.lock 已有资源台账）+ 同账户既有资源 → 归属证明成立，放行
    await expect(
      runNineSteps({
        rootDir: root,
        artifactRoot: art,
        client: new RestClient({ token: 't', fetchImpl: account.fetchImpl }),
        configOverride: cfg,
        http: SMOKE_OK,
        fetchJwks: async () => FIXED_JWKS,
      }),
    ).resolves.toBeDefined();
  });

  it('既有实例零影响：无 namespace 的配置资源名逐字不变（历史形态）', { timeout: 120_000 }, async () => {
    const art = await tmp('unself-272-artL-');
    const root = await tmp('unself-272-rootL-');
    await writeArtifactFixture(art);
    const account = makeCfRestFake({
      // 模拟「已经部署过的老实例」账户态：同名资源都在，但没有本实例台账（root 全新）
      existingD1: ['unself-core', 'unself-modules'],
      existingBuckets: ['unself-storage'],
      existingSecrets: { 'unself-core-api': ['JWT_PRIVATE_KEY'] },
    });
    await runNineSteps({
      rootDir: root,
      artifactRoot: art,
      client: new RestClient({ token: 't', fetchImpl: account.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      fetchJwks: async () => FIXED_JWKS,
    });
    // 资源名逐字不变（没有因为命名空间化变成孤儿）
    expect([...account.state.d1.keys()].sort()).toEqual(['unself-core', 'unself-modules']);
    expect([...account.state.buckets]).toEqual(['unself-storage']);
    expect(account.state.uploads.some((u) => u.worker === 'unself-core-api')).toBe(true);
    expect(account.state.uploads.some((u) => u.worker === 'unself-module-hello')).toBe(true);
    expect(activeResourceNamespace()).toBeUndefined();
    expect(coreWorkerName()).toBe('unself-core-api');
    expect(modulesDbName()).toBe('unself-modules');
    expect(withNamespacedBucket({ domain: '', modules: [], storage: { provider: 'r2', bucket: 'unself-storage' } }).storage)
      .toEqual({ provider: 'r2', bucket: 'unself-storage' });
  });

  it('R2 桶名纳入命名空间（真跑建桶用命名空间桶名）', { timeout: 120_000 }, async () => {
    const art = await tmp('unself-272-artBkt-');
    const root = await tmp('unself-272-rootBkt-');
    await writeArtifactFixture(art);
    const account = makeCfRestFake();
    await runNineSteps({
      rootDir: root,
      artifactRoot: art,
      client: new RestClient({ token: 't', fetchImpl: account.fetchImpl }),
      yes: true,
      configOverride: {
        domain: '',
        namespace: 'sitec',
        modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }],
        storage: { provider: 'r2', bucket: 'sitec-storage' },
      },
      http: SMOKE_OK,
    });
    const creates = account.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/r2/buckets'));
    expect(creates.map((c) => (c.body as { name: string }).name)).toEqual(['sitec-storage']);
    expect(account.state.buckets.has('unself-storage')).toBe(false);
  });
});
