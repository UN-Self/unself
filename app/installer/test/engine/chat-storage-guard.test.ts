// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #310 验收退回：装配入口前置校验（云资源写入前拒绝非法/危险选择）。
 *
 * 断言面：非法或危险选择必须在任何 CF 写入前抛出，且 fake 账户态零副作用；
 * 合法 shared/dedicated 正常推进。不解析命令行、不断言实现细节。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runNineSteps } from '../../src/engine/steps';
import { RestClient } from '../../src/engine/rest/client';
import { emptyLock } from '../../src/engine/lock';
import { makeCfRestFake } from './helpers/cf-rest-fake';
import { findRepoRoot } from '../helpers/repo-root';
import { cleanupTempWorkbenches, tempWorkbenchDir } from './helpers/fake-repo';

const ROOT = findRepoRoot();
const WB = await tempWorkbenchDir();
afterAll(cleanupTempWorkbenches);

const FIXED_JWKS = JSON.stringify({
  keys: [{
    kty: 'EC', crv: 'P-256',
    x: '2zYTVcy0bDXQ7qqeNDB38zsPVvwUkKZ6-m3xA1zwA2U',
    y: 'j8zUPxAyGRUAaHRNYwdU3IW7TSBI1kSrg7RmUhb8lZk',
    kid: 'RDB_5KqpPvLCvU7V6n8r6-xxpSJutKJCWNmyZWesNSg',
    use: 'sig', alg: 'ES256',
  }],
});

const SMOKE_OK = {
  smoke: async (b: string, mods: Array<{ id: string; baseUrl: string }>) =>
    ([{ name: 'core-api', url: `${b}/api/health`, ok: true, status: 200 }] as Array<{
      name: string; url: string; ok: boolean; status: number;
    }>).concat(mods.map((m) => ({ name: `module:${m.id}`, url: `${m.baseUrl}/api/health`, ok: true, status: 200 }))),
};

async function fakeChatFrontend(outDir: string): Promise<string> {
  const dir = join(outDir, 'modules/chat/assets/frontend');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), '<html><body>CHAT FRONTEND</body></html>');
  return 'chat/assets/frontend';
}

function configWith(declaration?: string) {
  return {
    domain: '',
    modules: [
      {
        id: 'chat',
        source: 'npm:@unself/chat@0.1.1',
        ...(declaration ? { storage: { declaration } } : {}),
      },
    ],
    storage: { provider: 'r2' as const, bucket: 'unself-storage' },
  };
}

/** 账户态零副作用：没有任何 D1/KV/桶创建、worker 上传或 secret 写入。 */
function expectNoCloudWrites(fake: ReturnType<typeof makeCfRestFake>): void {
  expect(fake.state.d1.size).toBe(0);
  expect(fake.state.kv.size).toBe(0);
  expect(fake.state.buckets.size).toBe(0);
  expect(fake.state.uploads).toHaveLength(0);
}

async function run(fake: ReturnType<typeof makeCfRestFake>, config: ReturnType<typeof configWith>, preLock = JSON.stringify(emptyLock())) {
  return runNineSteps({
    rootDir: ROOT,
    client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
    yes: true,
    configOverride: config as never,
    preLock,
    fetchJwks: async () => FIXED_JWKS,
    http: SMOKE_OK,
    workbenchDir: WB,
    buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
  });
}

describe('#310 装配入口前置校验（云写入前；#349 U5 两值）', () => {
  it('declaration=旧值（external，两值词表外）→ schema 层拒绝，账户零副作用', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake();
    await expect(run(fake, configWith('external'))).rejects.toThrow(/manifest 非法|Invalid option|core.*self/);
    expectNoCloudWrites(fake);
  });

  it('declaration=shared（两值词表外）→ schema 层拒绝，账户零副作用', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake();
    await expect(run(fake, configWith('shared'))).rejects.toThrow(/manifest 非法|Invalid option|core.*self/);
    expectNoCloudWrites(fake);
  });

  it('declaration=core（chat accepts 含 core）→ 推进装配', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake();
    await run(fake, configWith('core'));
    expect(fake.state.d1.size).toBeGreaterThan(0);
    expect(fake.state.buckets.has('unself-storage')).toBe(true);
  });

  it('declaration=self（chat accepts 不含 self）→ 前置拒绝，账户零副作用', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake();
    await expect(run(fake, configWith('self'))).rejects.toThrow(/accepts|不在.*内|manifest 非法/);
    expectNoCloudWrites(fake);
  });

  it('既有 core（自建表）落点（旧 lock 有 unself-chat）改选 self → 前置拒绝，不静默弃管', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake();
    const preLock = JSON.stringify({
      ...emptyLock(),
      resources: { d1: [{ name: 'unself-chat', id: 'old-chat-db' }], kv: [], r2: [], workers: [] },
    });
    // self 不在 chat accepts → 先被 accepts 检查拦（两值下这条守卫由 accepts 承载）
    await expect(run(fake, configWith('self'), preLock)).rejects.toThrow(/accepts|不在.*内|manifest 非法/);
    expectNoCloudWrites(fake);
  });

  it('既有 core 落点仍选 core → 正常推进（不误伤）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules', 'unself-chat'] });
    const preLock = JSON.stringify({
      ...emptyLock(),
      resources: { d1: [{ name: 'unself-chat', id: 'old-chat-db' }], kv: [], r2: [{ name: 'unself-chat-files' }], workers: [] },
    });
    await run(fake, configWith('core'), preLock);
    expect(fake.state.d1.has('unself-chat')).toBe(true);
  });
});
