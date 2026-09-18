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
import { CHAT_DB_NAME, CHAT_KV_NAME, CHAT_R2_NAME } from '../src/chat-provision';
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
  smoke: async (b: string, ids: string[]) =>
    ([{ name: 'core-api', url: `${b}/api/health`, ok: true, status: 200 }] as Array<{
      name: string; url: string; ok: boolean; status: number;
    }>).concat(ids.map((id) => ({ name: `module:${id}`, url: `${b}/m/${id}/api/health`, ok: true, status: 200 }))),
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

/** 与生产 discoverModules 同源：断言面期望从这里派生（参数化核心，#219 验收第 5 条）。 */
async function discoverIds(rootDir: string, selected: string[]): Promise<string[]> {
  return (await discoverModules(rootDir, selected)).map((m) => m.id).sort();
}

describe('#219 chat 全链路（干净装配「仅启用 chat」）', () => {
  it('专属 D1/KV/R2 补建请求在场；chat 走**通用 dedicated 迁移链**（独立记账 + 基线 import）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake();
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
    });
    // ① 专属资源补建：chat D1 + chat KV（平台两库与桶在别的断言覆盖）
    expect(fake.state.d1.has(CHAT_DB_NAME)).toBe(true);
    expect(fake.state.kv.has(CHAT_KV_NAME)).toBe(true);
    expect(fake.state.buckets.has(CHAT_R2_NAME)).toBe(true);
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
      configOverride: { domain: 'demo.handywote.top', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
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

  it('注册表三态之一（启用）：chat upsert enabled=1 且 entry=<baseUrl>/m/chat/；hello 未选 disable', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'], existingSecrets: { 'unself-core-api': ['JWT_PRIVATE_KEY'] } });
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
      fetchJwks: async () => FIXED_JWKS,
    });
    const chatRow = fake.state.registry.get('chat');
    expect(chatRow).toBeDefined();
    expect(chatRow!.enabled).toBe(1);
    expect(JSON.parse(chatRow!.manifest_json)).toMatchObject({ id: 'chat', entry: 'https://unself-core-api.test-subdomain.workers.dev/m/chat/' });
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
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
    });
    expect(summary1.chat).toEqual({ db: CHAT_DB_NAME, kv: CHAT_KV_NAME, r2: CHAT_R2_NAME, keyringAction: 'created' });
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
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
      fetchJwks: async () => FIXED_JWKS,
    });
    expect(second.state.d1.size).toBe(first.state.d1.size);
    expect(second.state.secretPuts).toEqual([]);
    expect(summary2.chat).toEqual({ db: CHAT_DB_NAME, kv: CHAT_KV_NAME, r2: CHAT_R2_NAME, keyringAction: 'existing' });
  });

  it('首部署密钥环注入后补 deploy（secret 生效）；已有密钥环零补部署', { timeout: 240_000 }, async () => {
    const fresh = makeCfRestFake();
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fresh.fetchImpl }),
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
    });
    const chatUploads = fresh.state.uploads.filter((u) => u.worker === 'unself-module-chat');
    expect(chatUploads.length).toBe(2); // 首部署 + secret put 后重部署
  });
});

describe('#219 模块面断言参数化（验收第 5 条）', () => {
  it('在仓全集与未选集合均由 discoverModules 现场派生（不硬编码模块名）', async () => {
    const selectedIds = ['chat'];
    const all = await discoverIds(ROOT, selectedIds);
    // 真实仓库现场：hello 与 chat 都在仓；期望集合 = 发现结果（而非手写清单）
    expect(all).toContain('hello');
    expect(all).toContain('chat');
    expect(all).toEqual([...new Set(all)].sort());
    // 选中/未选划分与 config.modules 一致
    const refs = await discoverModules(ROOT, selectedIds);
    expect(refs.find((m) => m.id === 'chat')!.selected).toBe(true);
    expect(refs.filter((m) => !m.selected).map((m) => m.id).sort()).toEqual(all.filter((id) => !selectedIds.includes(id)));
  });

  it('temp-root 双模块：新增目录进仓自动进断言面（discoverModules 通用性）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unself-disc-'));
    for (const [name, manifestId] of [['alpha', 'alpha'], ['beta', 'beta']] as const) {
      const dir = join(root, 'modules', name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'manifest.yaml'), `id: ${manifestId}\nroute: /m/${name}\nversion: 0.1.0\n`);
    }
    const refs = await discoverModules(root, ['beta']);
    expect(refs.map((m) => m.id).sort()).toEqual(['alpha', 'beta']);
    expect(refs.find((m) => m.id === 'beta')!.selected).toBe(true);
    expect(refs.find((m) => m.id === 'alpha')!.selected).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('「全停用」现场：registry 对在仓全集逐一 disable（期望由派生集合生成，chat/hello 同语义）', { timeout: 120_000 }, async () => {
    const all = await discoverIds(ROOT, []);
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'] });
    await runNineSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      configOverride: { domain: '', modules: [], storage: { provider: 'r2', bucket: 'unself-storage' } },
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
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
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
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
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
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async (i) => fakeChatFrontend(i.outDir),
      fetchJwks: async () => FIXED_JWKS,
    });
    expect(summary.chat).toEqual({ db: CHAT_DB_NAME, kv: CHAT_KV_NAME, r2: CHAT_R2_NAME, keyringAction: 'existing' });
    const chatUploads = second.state.uploads.filter((u) => u.worker === 'unself-module-chat');
    expect(chatUploads.length).toBeGreaterThanOrEqual(1);
    for (const u of chatUploads) {
      expect((u.metadata as { migrations?: unknown }).migrations).toBeUndefined();
    }
  });
});
