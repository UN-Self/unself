// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #310 验收退回专项行为测试（装配器侧）：
 * ① fresh shared：共享实例桶在模块上传前供给（状态型 fake 拒绝未存在桶绑定）；
 * ② 自备 S3：三来源择一 + 凭据轮换（提供即覆盖，不因已存在跳过）；
 * ③ 既有 dedicated 兼容：旧 lock 含模块 R2 → provider 切 s3 仍保留原落点。
 *
 * 断言面在账户态与上传 metadata（行为），不解析命令行。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runNineSteps } from '../../src/engine/steps';
import { RestClient } from '../../src/engine/rest/client';
import { chatR2Name } from '../../src/engine/chat-provision';
import { emptyLock } from '../../src/engine/lock';
import { moduleWorkerName } from '../../src/engine/naming';
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

/** 从 fake 的上传记录里取 chat worker 的 metadata bindings。 */
function chatBindings(fake: ReturnType<typeof makeCfRestFake>): Array<Record<string, unknown>> {
  const upload = fake.state.uploads.find((u) => u.worker === moduleWorkerName('chat'));
  return (upload?.metadata.bindings as Array<Record<string, unknown>> | undefined) ?? [];
}

const R2_SHARED_CONFIG = {
  domain: '',
  modules: [{ id: 'chat', source: 'npm:@unself/chat@0.1.1', storage: { declaration: 'shared' } }],
  storage: { provider: 'r2', bucket: 'unself-storage' },
} as const;

const S3_CONFIG = {
  domain: '',
  modules: [{ id: 'chat', source: 'npm:@unself/chat@0.1.1' }],
  storage: { provider: 's3', endpoint: 'https://s3.example.com', bucket: 'my-bucket', region: 'us-east-1' },
} as const;

const S3_CREDS = { accessKeyId: 'AK', secretAccessKey: 'SK' };

describe('#310 ① fresh shared 装配（桶供给前置）', () => {
  it('共享实例桶在模块上传前已建；chat 绑 modules 库 + DB_TABLE_PREFIX，不建专属 D1', { timeout: 120_000 }, async () => {
    // 全新账户：buckets 为空。若桶供给晚于上传，状态型 fake 会拒（r2 bucket not found）→ 装配失败。
    const fake = makeCfRestFake();
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: R2_SHARED_CONFIG as never,
      fetchJwks: async () => FIXED_JWKS,
      http: SMOKE_OK,
      workbenchDir: WB,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
    });

    // 共享实例桶已存在（前置供给），且未为 chat 建专属桶/专属 D1
    expect(fake.state.buckets.has('unself-storage')).toBe(true);
    expect(fake.state.buckets.has(chatR2Name())).toBe(false);
    expect(fake.state.d1.has('unself-chat')).toBe(false);

    const bindings = chatBindings(fake);
    const files = bindings.find((b) => b.type === 'r2_bucket' && b.name === 'FILES');
    expect(files?.bucket_name).toBe('unself-storage');
    expect(bindings.some((b) => b.type === 'plain_text' && b.name === 'DB_TABLE_PREFIX' && b.text === 'chat_')).toBe(true);
    const d1 = bindings.find((b) => b.type === 'd1' && b.name === 'DB');
    expect(typeof d1?.id).toBe('string');
    expect(d1?.id).toBe(fake.state.d1.get('unself-modules'));
  });
});

describe('#310 ② 自备 S3 与凭据轮换', () => {
  it('provider=s3 新装：绑 FILES_S3_* vars、不建桶、凭据即使已存在也覆盖写入', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({
      // 模拟「已有旧 key」：轮换必须覆盖，不能因存在而跳过
      existingSecrets: { [moduleWorkerName('chat')]: ['FILES_S3_ACCESS_KEY_ID', 'FILES_S3_SECRET_ACCESS_KEY'] },
    });
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: S3_CONFIG as never,
      s3Credentials: S3_CREDS,
      fetchJwks: async () => FIXED_JWKS,
      http: SMOKE_OK,
      workbenchDir: WB,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
    });

    const bindings = chatBindings(fake);
    expect(bindings.some((b) => b.type === 'r2_bucket' && b.name === 'FILES')).toBe(false);
    expect(bindings.find((b) => b.name === 'FILES_S3_ENDPOINT')?.text).toBe('https://s3.example.com');
    expect(bindings.find((b) => b.name === 'FILES_S3_BUCKET')?.text).toBe('my-bucket');
    // 不建桶（外部 S3）
    expect(fake.state.buckets.has('my-bucket')).toBe(false);
    // 轮换：两个 secret 都被 PUT（覆盖旧值），不留旧 key
    const puts = fake.state.secretPuts.filter((p) => p.worker === moduleWorkerName('chat')).map((p) => p.name);
    expect(puts).toContain('FILES_S3_ACCESS_KEY_ID');
    expect(puts).toContain('FILES_S3_SECRET_ACCESS_KEY');
  });
});

describe('#310 ③ 既有 dedicated 实例兼容（旧 lock 保留模块 R2）', () => {
  it('旧 lock 台账含 chat 模块 R2 → provider 切 s3 仍绑原 R2，不切 S3', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingBuckets: [chatR2Name()] });
    const preLock = JSON.stringify({
      ...emptyLock(),
      resources: { d1: [], kv: [], r2: [{ name: chatR2Name() }], workers: [] },
    });
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: S3_CONFIG as never,
      s3Credentials: S3_CREDS,
      preLock,
      fetchJwks: async () => FIXED_JWKS,
      http: SMOKE_OK,
      workbenchDir: WB,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
    });

    const bindings = chatBindings(fake);
    // 保留原附件落点：FILES 仍绑模块 R2 桶；不注入 S3 vars
    expect(bindings.find((b) => b.type === 'r2_bucket' && b.name === 'FILES')?.bucket_name).toBe(chatR2Name());
    expect(bindings.some((b) => b.name === 'FILES_S3_ENDPOINT')).toBe(false);
  });
});
