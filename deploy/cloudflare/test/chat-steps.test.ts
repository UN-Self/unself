// SPDX-License-Identifier: AGPL-3.0-only
/**
 * chat 全链路装配行为测试（#219 → #244 REST 化）：账户态替身（helpers/cf-rest-fake）+ 真实九步：
 * - 专属 D1/KV/R2 查漏补建（chat 选中时）；chat 不进记账迁移链（基线 schema 灌入）；
 * - 上传 metadata 带 DO 绑定 + 首部署 DO migrations；注册表三态（启用/停用）；
 * - 幂等：二跑零 create/put，密钥环已有不覆盖；
 * - 模块面断言参数化：期望集合由 discoverModules 现场派生（不硬编码模块名）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverModules, runNineSteps } from '../src/steps';
import { chatDbName, chatKvName, chatR2Name } from '../src/chat-provision';
import { makeCfRestFake } from './helpers/cf-rest-fake';
import { RestClient } from '../src/rest/client';

/** 仓库根（真实文件布局：modules/hello、modules/chat、services/core-api、apps/shell）。 */
const ROOT = new URL('../../..', import.meta.url).pathname;

async function fakeBuildShell(rootDir: string): Promise<void> {
  const dist = join(rootDir, 'apps/shell/dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<html><body>TEST SHELL</body></html>');
}

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

/** 步骤⑧ 签发经 REST /query（fake 迷你 SQL 态）——不再走 wrangler d1 execute。 */

/** chat 前端产物替身：真实落盘（上传路径读文件算 blake3 清单）。 */
async function fakeChatFrontend(outDir: string): Promise<string> {
  const dir = join(outDir, 'modules/chat/assets/frontend');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), '<html><body>CHAT FRONTEND</body></html>');
  return 'chat/assets/frontend';
}

/**
 * 与生产 discoverModules 同源：断言面期望从这里派生（参数化核心，#219 验收第 5 条）。
 * #284：discoverModules 只认 config 条目（不再扫模块目录）——期望面 = 传入的条目清单。
 */
async function discoverIds(_rootDir: string, entries: Array<{ id: string; source: string }>): Promise<string[]> {
  return (await discoverModules('', entries.map((e) => e.id), entries)).map((m) => m.id).sort();
}

describe('#219 chat 全链路（干净装配「仅启用 chat」）', () => {
  it('专属 D1/KV/R2 补建请求在场；chat 走**通用 dedicated 迁移链**（独立记账 + 基线 import）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake();
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'chat', source: 'npm:@unself/chat@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
    });
    // ① 专属资源补建：chat D1 + chat KV（平台两库与桶在别的断言覆盖）
    expect(fake.state.d1.has(chatDbName())).toBe(true);
    expect(fake.state.kv.has(chatKvName())).toBe(true);
    expect(fake.state.buckets.has(chatR2Name())).toBe(true);
    // ② #248 存储面去豁免：chat 与任何 dedicated 模块同一条链——独立记账表 unself_migrations_chat
    //    + 基线 schema（migrations/chat/0001_baseline.sql）按文件 import，记账名即模块 id。
    expect(fake.state.ledgerTables.has('unself_migrations_chat')).toBe(true);
    // 同一张账表：SQL 文件 + DO 迁移 tag（#255 归一）
    expect([...(fake.state.ledgerRows.get('unself_migrations_chat') ?? [])].sort()).toEqual([
      '0001_baseline.sql',
      'do-migration:v1',
    ]);
    expect(fake.state.importEtags.size).toBeGreaterThanOrEqual(1);
    expect(fake.state.registry.get('chat')).toBeDefined();
  });

  it('上传 metadata：/m/chat/* 路由 + 专属绑定 + DO 绑定/migrations + MODULE_ID/CORE_JWKS_JSON', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'], existingSecrets: { 'unself-core-api': ['JWT_PRIVATE_KEY'] }, zones: { 'handywote.top': 'zone-1' } });
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: 'demo.handywote.top', modules: [{ id: 'chat', source: 'npm:@unself/chat@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
      fetchJwks: async () => FIXED_JWKS,
    });
    const chatUpload = fake.state.uploads.find((u) => u.worker === 'unself-module-chat');
    expect(chatUpload).toBeDefined();
    const meta = chatUpload!.metadata as {
      bindings: Array<{ type: string; name: string; text?: string; [k: string]: unknown }>;
      migrations?: { new_tag: string; steps: Array<{ new_sqlite_classes: string[] }> };
    };
    const byName = new Map(meta.bindings.map((b) => [b.name, b]));
    expect(byName.get('DB')).toMatchObject({ type: 'd1' });
    expect(byName.get('SESSIONS')).toMatchObject({ type: 'kv_namespace' });
    expect(byName.get('FILES')).toMatchObject({ type: 'r2_bucket' });
    for (const doName of ['CHANNEL_ROOM', 'SCHEDULER', 'USER_INBOX']) {
      expect(byName.get(doName)).toMatchObject({ type: 'durable_object_namespace' });
    }
    expect(byName.get('ASSETS')).toMatchObject({ type: 'assets' });
    expect(byName.get('MODULE_ID')).toMatchObject({ type: 'plain_text', text: 'chat' });
    expect(JSON.parse(String(byName.get('CORE_JWKS_JSON')!.text)).keys).toHaveLength(1);
    // 首部署：DO migrations 元数据在场（new_tag=v1，一条迁移含三类）
    expect(meta.migrations?.new_tag).toBe('v1');
    expect(meta.migrations?.steps.flatMap((s) => s.new_sqlite_classes)).toEqual(['ChannelRoom', 'Scheduler', 'UserInbox']);
    // 路由绑定（zone 模式）
    expect(fake.state.routes.has('demo.handywote.top/m/chat/*')).toBe(true);
    // wrapper 落位
    await expect(readFile(join(ROOT, '.deploy/cloudflare/modules/chat/worker.js'), 'utf8')).resolves.toContain("const PREFIX = '/m/chat'");
  });

  it('注册表三态之一（启用）：chat upsert enabled=1 且 entry=模块自有子域（#273）；hello 未选 disable', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'], existingSecrets: { 'unself-core-api': ['JWT_PRIVATE_KEY'] } });
    // #284：未选 = config 删了但 lock 里还记着（目录扫描已废）
    const preLock = JSON.stringify({
      lockVersion: 1,
      generatedAt: '2026-09-19T00:00:00.000Z',
      modules: { hello: { source: 'npm:@unself/hello@0.1.0', version: '0.1.0', manifestHash: 'a'.repeat(64), contractVersion: '1.0' } },
    });
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      preLock,
      configOverride: { domain: '', modules: [{ id: 'chat', source: 'npm:@unself/chat@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
      fetchJwks: async () => FIXED_JWKS,
    });
    const chatRow = fake.state.registry.get('chat');
    expect(chatRow).toBeDefined();
    expect(chatRow!.enabled).toBe(1);
    expect(JSON.parse(chatRow!.manifest_json)).toMatchObject({ id: 'chat', entry: 'https://unself-module-chat.test-subdomain.workers.dev/' });
    // hello 未选 → disable（行不在库 → UPDATE 照发，changes=0；真库同语义）
    expect(
      fake.calls.some((c) => (c.body as { sql?: string; params?: unknown[] } | undefined)?.sql?.startsWith('UPDATE module_registry') &&
        (c.body as { params?: unknown[] }).params?.[0] === 'hello'),
    ).toBe(true);
  });
});

describe('#219 幂等与密钥环（二跑收敛）', () => {
  it('二跑零 create/put：D1/KV/R2 全收敛，密钥环已有不覆盖', { timeout: 240_000 }, async () => {
    const first = makeCfRestFake();
    const summary1 = await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: first.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'chat', source: 'npm:@unself/chat@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
    });
    expect(summary1.chat).toEqual({ db: chatDbName(), kv: chatKvName(), r2: chatR2Name(), keyringAction: 'created' });
    expect(first.state.secretPuts).toEqual([
      { worker: 'unself-core-api', name: 'JWT_PRIVATE_KEY' },
      { worker: 'unself-module-chat', name: 'EDGECHAT_ENCRYPTION_KEYRING' },
    ]);

    // 二跑：同一账户状态延续（资源已在、密钥环已在）
    const second = makeCfRestFake({
      existingD1: [...first.state.d1.keys()],
      existingBuckets: [...first.state.buckets],
      existingKv: [...first.state.kv.keys()],
      existingSecrets: Object.fromEntries([...first.state.secrets].map(([w, s]) => [w, [...s]])),
      existingWorkers: [...first.state.existingWorkers],
      existingLedger: Object.fromEntries([...first.state.ledgerRows].map(([t, rows]) => [t, [...rows]])),
    });
    const summary2 = await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: second.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'chat', source: 'npm:@unself/chat@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
      fetchJwks: async () => FIXED_JWKS,
    });
    expect(second.state.d1.size).toBe(first.state.d1.size);
    expect(second.state.secretPuts).toEqual([]);
    expect(summary2.chat).toEqual({ db: chatDbName(), kv: chatKvName(), r2: chatR2Name(), keyringAction: 'existing' });
  });

  it('首部署密钥环注入后补 deploy（secret 生效）；已有密钥环零补部署', { timeout: 240_000 }, async () => {
    const fresh = makeCfRestFake();
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fresh.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'chat', source: 'npm:@unself/chat@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
    });
    const chatUploads = fresh.state.uploads.filter((u) => u.worker === 'unself-module-chat');
    expect(chatUploads.length).toBe(2); // 首部署 + secret put 后重部署
  });
});

describe('#219 模块面断言参数化（验收第 5 条）', () => {
  it('discoverModules 只认 config 条目：给什么返回什么（不再扫目录）', async () => {
    const entries = [
      { id: 'chat', source: 'npm:@unself/chat@0.1.0' },
      { id: 'hello', source: 'npm:@unself/hello@0.1.0' },
    ];
    const all = await discoverIds(ROOT, entries);
    expect(all).toEqual(['chat', 'hello']);
    const refs = await discoverModules(ROOT, ['chat', 'hello'], entries);
    expect(refs.map((m) => m.id).sort()).toEqual(['chat', 'hello']);
    // #284：config 是所有条目的唯一来源 —— 目录里存在但 config 未声明的模块不再出现
    expect(refs.every((m) => m.selected)).toBe(true);
    expect(refs.every((m) => m.source !== undefined)).toBe(true);
  });

  it('temp-root 里的模块目录不再影响发现面（#284：目录扫描已删）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unself-disc-'));
    for (const name of ['alpha', 'beta'] as const) {
      const dir = join(root, 'modules', name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'manifest.yaml'), `id: ${name}\nroute: /m/${name}\nversion: 0.1.0\n`);
    }
    const refs = await discoverModules(root, ['beta'], [{ id: 'beta', source: 'file:./modules/beta' }]);
    expect(refs.map((m) => m.id)).toEqual(['beta']);
    expect(refs[0]!.selected).toBe(true);
    expect(refs[0]!.source).toBe('file:./modules/beta');
    await rm(root, { recursive: true, force: true });
  });

  it('「全停用」现场：lock 里记过的模块被逐一 disable（期望由 lock 派生，chat/hello 同语义）', { timeout: 120_000 }, async () => {
    const preLock = JSON.stringify({
      lockVersion: 1,
      generatedAt: '2026-09-19T00:00:00.000Z',
      modules: {
        hello: { source: 'npm:@unself/hello@0.1.0', version: '0.1.0', manifestHash: 'a'.repeat(64), contractVersion: '1.0' },
        chat: { source: 'npm:@unself/chat@0.1.0', version: '0.1.0', manifestHash: 'b'.repeat(64), contractVersion: '1.0' },
      },
    });
    const all = ['chat', 'hello'];
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'] });
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      configOverride: { domain: '', modules: [], storage: { provider: 'r2', bucket: 'unself-storage' } },
      preLock,
      yes: true,
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
    });
    for (const id of all) {
      expect(
        fake.calls.some((c) => (c.body as { sql?: string; params?: unknown[] } | undefined)?.sql?.startsWith('UPDATE module_registry') &&
          (c.body as { params?: unknown[] }).params?.[0] === id),
      ).toBe(true);
    }
  });
});

describe('#255 DO 迁移判定 = 记账事实（不再靠 isWorkerNew / 脚本存在与否）', () => {
  /** 首次真部署：干净账户态（无 stub、无记账）。 */
  async function deployChat(): Promise<ReturnType<typeof makeCfRestFake>> {
    const fake = makeCfRestFake();
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'chat', source: 'npm:@unself/chat@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
      fetchJwks: async () => FIXED_JWKS,
    });
    return fake;
  }

  it('脚本已存在但 DO 类未建（占位 stub）→ 部署必须发 DO migrations 并记进模块账', { timeout: 120_000 }, async () => {
    // 线上实况复现：09-16 wrangler 直连部署的 298B 占位 stub——脚本在，
    // CHANNEL_ROOM/SCHEDULER/USER_INBOX 三个 SQLite 类都没建。旧判定 isWorkerNew=false → 迁移不发。
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingWorkers: ['unself-module-chat'],
      existingSecrets: { 'unself-core-api': ['JWT_PRIVATE_KEY'] },
    });
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'chat', source: 'npm:@unself/chat@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
      fetchJwks: async () => FIXED_JWKS,
    });
    const chatUploads = fake.state.uploads.filter((u) => u.worker === 'unself-module-chat');
    const withMigrations = chatUploads.find((u) => (u.metadata as { migrations?: unknown }).migrations);
    expect(withMigrations, '脚本已存在但类未建时，DO 迁移必须随上传发出').toBeDefined();
    const migrations = (withMigrations!.metadata as {
      migrations: { old_tag?: string; new_tag: string; steps: Array<{ new_sqlite_classes: string[] }> };
    }).migrations;
    expect(migrations.old_tag).toBeUndefined(); // 无前序 DO 迁移 → 首应用
    expect(migrations.new_tag).toBe('v1');
    expect(migrations.steps.flatMap((s) => s.new_sqlite_classes)).toEqual(['ChannelRoom', 'Scheduler', 'UserInbox']);
    // 同一套记账（#248）：tag 记在模块账表里，不是第二张表
    expect([...(fake.state.ledgerRows.get('unself_migrations_chat') ?? [])]).toContain('do-migration:v1');
    // 同一次运行内的重传（密钥环 secret 生效补 deploy）不再带迁移（重复 tag 会被 CF 拒，10079）
    const last = chatUploads[chatUploads.length - 1]!;
    expect((last.metadata as { migrations?: unknown }).migrations).toBeUndefined();
  });

  it('DO 类已存在（上次真部署已记账）→ 幂等重跑不带 migrations、不报错', { timeout: 240_000 }, async () => {
    const first = await deployChat();
    expect(
      first.state.uploads.filter((u) => u.worker === 'unself-module-chat').some((u) => (u.metadata as { migrations?: unknown }).migrations),
    ).toBe(true);
    const second = makeCfRestFake({
      existingD1: [...first.state.d1.keys()],
      existingBuckets: [...first.state.buckets],
      existingKv: [...first.state.kv.keys()],
      existingSecrets: Object.fromEntries([...first.state.secrets].map(([w, s]) => [w, [...s]])),
      existingWorkers: [...first.state.existingWorkers],
      existingLedger: Object.fromEntries([...first.state.ledgerRows].map(([t, rows]) => [t, [...rows]])),
    });
    const summary = await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: second.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'chat', source: 'npm:@unself/chat@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
      fetchJwks: async () => FIXED_JWKS,
    });
    expect(summary.chat).toEqual({ db: chatDbName(), kv: chatKvName(), r2: chatR2Name(), keyringAction: 'existing' });
    const chatUploads = second.state.uploads.filter((u) => u.worker === 'unself-module-chat');
    expect(chatUploads.length).toBeGreaterThanOrEqual(1);
    for (const u of chatUploads) {
      expect((u.metadata as { migrations?: unknown }).migrations).toBeUndefined();
    }
  });
});
