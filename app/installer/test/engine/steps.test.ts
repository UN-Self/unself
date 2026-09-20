// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 幂等九步编排行为测试（#244 REST 化后）：账户态替身（test/helpers/cf-rest-fake.ts）+
 * runNineSteps 真实代码路径。断言全部落在「发了哪些请求 / 账户态如何变化 / 摘要形状」——
 * 不再解析 wrangler 命令行（决策 #65：生产零 wrangler）。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { prefixStripWrapperSource } from '../../src/engine/assemble';
import { needsTotalTls, runNineSteps } from '../../src/engine/steps';
import { makeCfRestFake } from './helpers/cf-rest-fake';
import { RestClient } from '../../src/engine/rest/client';
import { cleanupTempWorkbenches, tempWorkbenchDir } from './helpers/fake-repo';
import { findRepoRoot } from '../helpers/repo-root';
import { FAKE_CORE_WORKER } from './helpers/workbench-fixture';

/**
 * runNineSteps 带测试默认值的小包装：默认指向临时合成的平台产物包（WB）。
 * 壳与 core Worker bundle 现在是**搬运**（来自 workbench 包），测试不再需要假装构建。
 */
function runSteps(input: Parameters<typeof runNineSteps>[0]) {
  return runNineSteps({ workbenchDir: WB, ...input });
}

/** 仓库根（真实文件布局：app/modules/hello、app/modules/chat、app/workbench、app/workbench）。 */
const ROOT = findRepoRoot();

// 平台产物夹具（临时合成，测试不依赖仓库 app/workbench 已构建）
const WB = await tempWorkbenchDir();
afterAll(cleanupTempWorkbenches);

afterEach(() => vi.unstubAllGlobals());

/** 合法公钥 JWKS 字符串（真实 P-256 公钥 JWK 形状的静态夹具，与 core GET /.well-known/jwks.json 同形）。 */
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

/** #284：未选模块的判据 = 「lock 里记过、config 里没有」——下面两个「modules: []」用例用它造现场。 */
const HELLO_PRE_LOCK = JSON.stringify({
  lockVersion: 1,
  generatedAt: '2026-09-19T00:00:00.000Z',
  modules: { hello: { source: 'npm:@unself/hello@0.1.0', version: '0.1.0', manifestHash: 'a'.repeat(64), contractVersion: '1.0' } },
});

const SMOKE_OK = {
  smoke: async (b: string, mods: Array<{ id: string; baseUrl: string }>) =>
    ([{ name: 'core-api', url: `${b}/api/health`, ok: true, status: 200 }] as Array<{
      name: string;
      url: string;
      ok: boolean;
      status: number;
    }>).concat(
      mods.map((m) => ({ name: `module:${m.id}`, url: `${m.baseUrl}/api/health`, ok: true, status: 200 })),
    ),
};

describe('needsTotalTls（Universal SSL 覆盖边界）', () => {
  it('一级子域：覆盖，不需要', () => {
    expect(needsTotalTls('unself.handywote.top', 'handywote.top')).toBe(false);
  });
  it('多级子域：不覆盖，需要', () => {
    expect(needsTotalTls('unself.demo.handywote.top', 'handywote.top')).toBe(true);
  });
  it('apex 自身：覆盖，不需要', () => {
    expect(needsTotalTls('handywote.top', 'handywote.top')).toBe(false);
  });
});

describe('runNineSteps（九步编排 · 幂等收敛 · REST）', () => {
  it('空账号首跑：请求序覆盖九步；二跑零 create/put（收敛）', { timeout: 120_000 }, async () => {
    const first = makeCfRestFake();
    const summary1 = await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: first.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
    });
    // workers.dev 模式：resolveBaseUrl 真实路径 = 子域查询 + core 启用
    expect(summary1.baseUrl).toBe('https://unself-workbench.test-subdomain.workers.dev');
    // 首跑：两 D1 create + secret put 一次 + registry upsert hello
    const d1Creates = first.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/d1/database'));
    expect(d1Creates.map((c) => (c.body as { name: string }).name).sort()).toEqual(['unself-core', 'unself-modules']);
    expect(first.state.secretPuts).toEqual([{ worker: 'unself-workbench', name: 'JWT_PRIVATE_KEY' }]);
    expect(first.state.registry.get('hello')).toBeDefined();
    expect(first.state.registry.get('hello')?.enabled).toBe(1);
    // assets 契约（真机 2026-09-18）：manifest key 以 / 开头（否则 CF 10304）+ hash 为 32 位 hex（wrangler hash.ts 同款）
    const shellManifest = first.state.assetManifests.find((m) => Object.keys(m).some((k) => k.startsWith('/index.html')))!;
    expect(Object.keys(shellManifest).every((k) => k.startsWith('/'))).toBe(true);
    expect(Object.values(shellManifest).every((e) => /^[0-9a-f]{32}$/.test(e.hash))).toBe(true);
    // #279：上传 part 的 Content-Type 按扩展名（CF 直传契约：serving 类型 = part 类型）——
    // 此处跑的是**真产物树 + 真上传代码路径**，覆盖壳资产与模块资产两个入口（同为 uploadWorkerSpec）。
    const partType = new Map(first.state.assetUploadParts.map((p) => [p.name, p.type]));
    const wantType: Array<[string, RegExp]> = [
      ['.html', /^text\/html/],
      ['.mjs', /^text\/javascript/],
      ['.js', /^text\/javascript/],
      ['.css', /^text\/css/],
      ['.svg', /^image\/svg\+xml/],
      ['.woff2', /^font\/woff2/],
      ['.woff', /^font\/woff/],
      ['.png', /^image\/png/],
      ['.webp', /^image\/webp/],
      ['.avif', /^image\/avif/],
      ['.ico', /^image\/vnd\.microsoft\.icon/],
      ['.json', /^application\/json/],
      ['.wasm', /^application\/wasm/],
      ['.webmanifest', /^application\/manifest\+json/],
    ];
    let typedAssets = 0;
    for (const manifest of first.state.assetManifests) {
      for (const [path, entry] of Object.entries(manifest)) {
        const expected = wantType.find(([suffix]) => path.toLowerCase().endsWith(suffix));
        if (!expected) continue;
        const type = partType.get((entry as { hash: string }).hash);
        expect(type, `${path} 的 part 类型（#279）`).toBeDefined();
        expect(type, `${path} 的 part 类型（#279）`).toMatch(expected[1]);
        typedAssets++;
      }
    }
    // 真壳产物必有 html + js + css（否则断言退化成空跑）
    expect(typedAssets).toBeGreaterThan(2);
    // 迁移：import 进 core 库 + 模块记账独立（unself_migrations_core / unself_migrations_hello）
    expect(first.state.importEtags.size).toBeGreaterThan(0);
    expect(first.state.ledgerTables.has('unself_migrations_core')).toBe(true);
    // 步骤⑧（#165 方案 B）：本地签发直插 core 库（经 REST /query）
    const issued = first.state.setupToken;
    expect(issued).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(summary1.setup).toEqual({ setupUrl: `/setup?token=${issued}` });

    // 二跑（同一 fake 账户状态延续；token 已签发但未消费）
    const second = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingBuckets: ['unself-storage'],
      existingSecrets: { 'unself-workbench': ['JWT_PRIVATE_KEY'] },
      existingSetupToken: issued,
    });
    const summary2 = await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: second.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      fetchJwks: async () => FIXED_JWKS,
    });
    // 收敛：零创建（POST /d1/database 本体 = 创建；/query|/import 是操作不算）、零 secret 重写、registry 仍 upsert
    expect(second.calls.some((c) => c.method === 'POST' && c.url.endsWith('/d1/database'))).toBe(false);
    expect(second.state.secretPuts).toEqual([]);
    expect(second.state.registry.get('hello')).toBeDefined();
    // 二跑幂等：复用未消费 token（不重复 INSERT），摘要逐字一致
    expect(second.state.setupToken).toBe(issued);
    expect(summary2.setup).toEqual(summary1.setup);
    expect(summary2.keypairAction).toBe('existing');
    expect(summary1.keypairAction).toBe('created');
  });

  it('九步顺序：D1→迁移→上传→registry→R2→（⑦无操作）→签发⑧→HTTP⑨（请求时间序）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'] });
    await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
    });
    const calls = fake.calls;
    const idxOf = (pred: (c: { method: string; url: string; body?: unknown }) => boolean) => calls.findIndex(pred);
    const firstD1 = idxOf((c) => c.url.endsWith('/d1/database'));
    const firstImport = idxOf((c) => c.url.includes('/import') && c.method === 'POST');
    const firstUpload = idxOf((c) => c.method === 'PUT' && c.url.includes('/workers/scripts/'));
    const sqlStartsWith = (prefix: string) => (c: { body?: unknown }) =>
      typeof (c.body as { sql?: string } | undefined)?.sql === 'string' &&
      ((c.body as { sql?: string }).sql as string).startsWith(prefix);
    const registryUpsert = idxOf(sqlStartsWith('INSERT INTO module_registry'));
    const r2Create = idxOf((c) => c.url.endsWith('/r2/buckets') && c.method === 'POST');
    const setupInsert = idxOf(sqlStartsWith('INSERT INTO setup_tokens'));
    expect(firstImport).toBeGreaterThan(firstD1);
    expect(firstUpload).toBeGreaterThan(firstImport);
    expect(registryUpsert).toBeGreaterThan(firstUpload);
    expect(r2Create).toBeGreaterThan(registryUpsert);
    expect(setupInsert).toBeGreaterThan(r2Create);
    // registry 终态：#284 未选模块只来自 lock（config 只有 hello、lock 为空 → 没有可 disable 的）
    const toggles = calls.filter(sqlStartsWith('UPDATE module_registry'));
    expect(toggles).toHaveLength(0);
  });

  it('domain 设定时：core 上传后立即 ensureDns（先于 registry 与冒烟）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      zones: { 'handywote.top': 'zone-1' },
    });
    const order: string[] = [];
    await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: 'demo.handywote.top', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      cleanupCustomDomains: async () => {
        order.push('__cleanupCustomDomains');
      },
      ensureTotalTls: async () => {
        order.push('__ensureTotalTls');
      },
      // ensureDns 不注入 → 真实 ensureZoneARecord（fake 支持 dns_records）
    });
    expect(order).toEqual(['__cleanupCustomDomains', '__ensureTotalTls']);
    // 顺序：Custom Domain 清理 → Total TLS → core 上传 → DNS 自建 → registry（真实 A 记录 POST）
    const coreUpload = fake.calls.findIndex((c) => c.method === 'PUT' && c.url.includes('/workers/scripts/unself-workbench'));
    const dnsIdx = fake.calls.findIndex((c) => c.url === '/zones/zone-1/dns_records' && c.method === 'POST');
    expect(coreUpload).toBeGreaterThan(-1);
    expect(dnsIdx).toBeGreaterThan(coreUpload);
    const registryUpsert = fake.calls.findIndex((c) => (c.body as { sql?: string } | undefined)?.sql?.startsWith('INSERT INTO module_registry'));
    expect(registryUpsert).toBeGreaterThan(dnsIdx);
  });

  it('未选模块（modules: []）→ 删除其 zone 路由，注册表 disable 照旧（#77）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      zones: { 'handywote.top': 'zone-1' },
      routes: [['demo.handywote.top/m/hello/*', 'unself-module-hello']],
    });
    await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      // 零模块：app/modules/hello 存在但未选中 → 必须删其 zone 路由（§6.5 全停用空态可表达；真实 removeRoutesForPatterns）
      yes: true,
      preLock: HELLO_PRE_LOCK,
      configOverride: { domain: 'demo.handywote.top', modules: [], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
    });
    // 路由删除请求发生（DELETE zone route）：既有 hello 路由被清掉
    expect(fake.calls.some((c) => c.method === 'DELETE' && c.url.includes('/workers/routes/'))).toBe(true);
    expect(fake.state.routes.has('demo.handywote.top/m/hello/*')).toBe(false);
    // 注册表翻转照旧（not_deployed），且删除在步骤⑤之前
    const disableIdx = fake.calls.findIndex((c) => (c.body as { sql?: string } | undefined)?.sql?.includes("module_registry SET enabled = ?2"));
    const routeDeleteIdx = fake.calls.findIndex((c) => c.method === 'DELETE' && c.url.includes('/workers/routes/'));
    expect(disableIdx).toBeGreaterThan(routeDeleteIdx);
    // 只删路由：未选模块不部署 Worker（不重新上传）
    expect(fake.state.uploads.some((u) => u.worker === 'unself-module-hello')).toBe(false);
  });

  it('未配置 domain（workers.dev）→ 未选模块跳过路由删除（无 zone 路由）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'] });
    let routeCalls = 0;
    await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      preLock: HELLO_PRE_LOCK,
      configOverride: { domain: '', modules: [], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      cleanupModuleRoutes: async () => {
        routeCalls++;
      },
    });
    expect(routeCalls).toBe(0);
    // 注册表 disable 仍照旧（行不存在 → UPDATE 照发，changes=0 语义与真库一致）
    expect(
      fake.calls.some((c) => (c.body as { sql?: string; params?: unknown[] } | undefined)?.sql?.startsWith('UPDATE module_registry') &&
        (c.body as { params?: unknown[] }).params?.[0] === 'hello'),
    ).toBe(true);
  });

  it('冒烟失败 → 明确报错非零语义', async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'] });
    await expect(
      runSteps({
        rootDir: ROOT,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
        http: {
          smoke: async () => [{ name: 'core-api', url: 'x', ok: false, status: 503, detail: 'HTTP 503' }],
        },
      }),
    ).rejects.toThrow(/冒烟失败/);
  });

  it('setup 已封死（#165 本地探测）→ 不签发 token、摘要记录 sealed 且不失败', async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'], setupDone: true });
    const summary = await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
    });
    expect(summary.setup).toEqual({ sealed: true });
    expect(fake.state.setupToken).toBeNull();
  });

  it('分支 A：首部署（无 secret）→ vars.CORE_JWKS_JSON 用本运行公钥，不调用 fetchJwks', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake();
    let fetchCalls = 0;
    await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      // spy：被调用即失败——分支 A 必须完全跳过公网抓取
      fetchJwks: async () => {
        fetchCalls++;
        throw new Error('分支 A 不应调用 fetchJwks');
      },
    });
    expect(fetchCalls).toBe(0);
    const cfg = JSON.parse(
      await readFile(join(ROOT, '.deploy/cloudflare/modules/hello.wrangler.jsonc'), 'utf8'),
    ) as { vars: { CORE_JWKS_JSON: string } };
    const jwks = JSON.parse(cfg.vars.CORE_JWKS_JSON) as { keys: Array<Record<string, string>> };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kty).toBe('EC');
    expect(jwks.keys[0]?.crv).toBe('P-256');
    expect(jwks.keys[0]?.kid).toBeTruthy();
    expect(jwks.keys[0]?.use).toBe('sig');
    expect(jwks.keys[0]?.alg).toBe('ES256');
  });

  it('分支 B：已有 secret → 公网抓取 JWKS 注入 vars.CORE_JWKS_JSON（fetchJwks 收到 baseUrl）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingSecrets: { 'unself-workbench': ['JWT_PRIVATE_KEY'] },
    });
    const received: string[] = [];
    await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      fetchJwks: async (baseUrl) => {
        received.push(baseUrl);
        return FIXED_JWKS;
      },
    });
    expect(received).toEqual([`${'https://unself-workbench'}.test-subdomain.workers.dev`]);
    const cfg = JSON.parse(
      await readFile(join(ROOT, '.deploy/cloudflare/modules/hello.wrangler.jsonc'), 'utf8'),
    ) as { vars: { CORE_JWKS_JSON: string } };
    expect(cfg.vars.CORE_JWKS_JSON).toBe(FIXED_JWKS);
  });

  it('分支 C：公网抓取失败 → 硬报错（含「无法获取 Core 公钥」与重跑提示）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingSecrets: { 'unself-workbench': ['JWT_PRIVATE_KEY'] },
    });
    await expect(
      runSteps({
        rootDir: ROOT,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
        http: SMOKE_OK,
        fetchJwks: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow(/无法获取 Core 公钥/);
    await expect(
      runSteps({
        rootDir: ROOT,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
        http: SMOKE_OK,
        fetchJwks: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow(/可重跑部署（幂等）/);
  });

  it('主题体检失败（模块页未解析令牌）→ 明确报错（§6.5.8 当场红）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'] });
    await expect(
      runSteps({
        rootDir: ROOT,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
        http: {
          ...SMOKE_OK,
          themeCheck: async () => [
            { name: 'module:hello', url: 'https://x.example/m/hello/', ok: false, skinned: false, unknown: ['--color-primary', '--unself-space4'] },
          ],
        },
      }),
    ).rejects.toThrow(
      /主题体检失败：module:hello\(https:\/\/x\.example\/m\/hello\/\): 未知令牌 --color-primary、--unself-space4/,
    );
  });

  it('主题体检通过（含独立皮肤 skinned:true）→ resolve 且 summary.themeChecks 透传', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'] });
    const themeChecks = [
      { name: 'module:hello', url: 'https://x.example/m/hello/', ok: true, skinned: true, unknown: [] },
    ];
    const summary = await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: {
        ...SMOKE_OK,
        themeCheck: async () => themeChecks,
      },
    });
    expect(summary.themeChecks).toEqual(themeChecks);
  });

  it('http 存在但无 themeCheck → 跳过主题体检（summary.themeChecks=[]，不触发网络）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'] });
    const summary = await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
    });
    expect(summary.themeChecks).toEqual([]);
  });
});

describe('#273 workers.dev 模块可达 / 自有域回归', () => {
  it('workers.dev：模块自有子域启用 + registry entry = 子域 URL + 冒烟探测子域', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'] });
    const seen: Array<{ id: string; baseUrl: string }> = [];
    const summary = await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: {
        ...SMOKE_OK,
        smoke: async (coreUrl, mods) => {
          seen.push(...mods);
          return SMOKE_OK.smoke(coreUrl, mods);
        },
      },
    });
    // 模块自有子域已启用（core 与模块各自一个）
    expect([...fake.state.workersDevEnabled].sort()).toEqual(['unself-module-hello', 'unself-workbench']);
    // 注册表 entry = 模块真实 URL（模块自有 workers.dev 子域）
    const manifest = JSON.parse(fake.state.registry.get('hello')!.manifest_json) as { entry: string };
    expect(manifest.entry).toBe('https://unself-module-hello.test-subdomain.workers.dev/');
    // ⑨ 冒烟拿到就是模块自有子域 target（不是 core 的 /m/hello）
    expect(seen).toEqual([{ id: 'hello', baseUrl: 'https://unself-module-hello.test-subdomain.workers.dev' }]);
    expect(summary.baseUrl).toBe('https://unself-workbench.test-subdomain.workers.dev');
  });

  it('自有域形态回归：zone 路由 + entry=/m/<id>/ + 冒烟走 zone 路径，不启 workers.dev', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      zones: { 'handywote.top': 'zone-1' },
    });
    const seen: Array<{ id: string; baseUrl: string }> = [];
    await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: 'demo.handywote.top', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: {
        ...SMOKE_OK,
        smoke: async (coreUrl, mods) => {
          seen.push(...mods);
          return SMOKE_OK.smoke(coreUrl, mods);
        },
      },
    });
    // zone 路径路由逐字不变；entry 仍为同域 /m/<id>/；探测点同域
    expect(fake.state.routes.get('demo.handywote.top/m/hello/*')).toBe('unself-module-hello');
    const manifest = JSON.parse(fake.state.registry.get('hello')!.manifest_json) as { entry: string };
    expect(manifest.entry).toBe('https://demo.handywote.top/m/hello/');
    expect(seen).toEqual([{ id: 'hello', baseUrl: 'https://demo.handywote.top/m/hello' }]);
    // 自有域形态不涉及 workers.dev 子域（零启用请求）
    expect([...fake.state.workersDevEnabled]).toEqual([]);
  });

  it('workers.dev：模块自有子域不可达 → ⑨ 冒烟真红，不静默跳过', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingSecrets: { 'unself-workbench': ['JWT_PRIVATE_KEY'] },
    });
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('unself-module-hello')) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await expect(
      runSteps({
        rootDir: ROOT,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
        fetchJwks: async () => FIXED_JWKS,
      }),
    ).rejects.toThrow(/冒烟失败：module:hello/);
    // 探测的确实是模块自有子域（而不是 core 的 /m/hello）
    expect(calls).toContain('https://unself-module-hello.test-subdomain.workers.dev/api/health');
  });
});

describe('D1（#162/#194）：入口产物「存在即跳过」陷阱', () => {
  it('预置旧模板 core-worker.js 在场 → 部署后产物被刷新为当前模板（升级路径不再沿用旧入口）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'] });
    const outDir = join(ROOT, '.deploy/cloudflare');
    const entryPath = join(outDir, 'core-worker.js');
    // 预置上一版生成物：旧入口模板（import default——即 #162 实锤的 No matching export 形态）
    const stale = `// SPDX-License-Identifier: AGPL-3.0-only
import app from '../../app/workbench/src/index.ts';
export default { fetch: (r, e, c) => app.fetch(r, e, c) };
`;
    await mkdir(outDir, { recursive: true });
    await writeFile(entryPath, stale);
    try {
      await runSteps({
        rootDir: ROOT,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
        http: SMOKE_OK,
      });
        // 行为断言（不测实现）：文件内容 == 平台产物包里的 core Worker bundle（陈旧入口被覆写掉）
        const after = await readFile(entryPath, 'utf8');
        expect(after).toBe(FAKE_CORE_WORKER);
        expect(after).not.toContain('import app from');
    } finally {
      await rm(entryPath, { force: true });
    }
  });

  it('预置旧模板 modules/hello/worker.js 在场 → 部署后 wrapper 产物被刷新为当前模板（#162 同类陷阱回归）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({ existingD1: ['unself-core', 'unself-modules'] });
    const outDir = join(ROOT, '.deploy/cloudflare');
    const wrapperPath = join(outDir, 'modules/hello/worker.js');
    // 预置上一版生成物：旧 wrapper 模板形态（无前缀常量/无安全头——模板演进后旧产物必须被覆写）
    const stale = `// 旧版 wrapper 生成物
import worker from './app.js';
export default { fetch: (r, e, c) => worker.fetch(r, e, c) };
`;
    await mkdir(join(outDir, 'modules/hello'), { recursive: true });
    await writeFile(wrapperPath, stale);
    try {
      await runSteps({
        rootDir: ROOT,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        yes: true,
      configOverride: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
        http: SMOKE_OK,
      });
      // 行为断言（不测实现）：文件内容 == 当前 wrapper 模板输出（旧内容已被覆写掉）
      // workers.dev 形态（#273）：根挂载 mount=''，frame-ancestors = 壳 origin
      const after = await readFile(wrapperPath, 'utf8');
      expect(after).toBe(
        prefixStripWrapperSource('hello', {
          mount: '',
          shellOrigin: 'https://unself-workbench.test-subdomain.workers.dev',
        }),
      );
      expect(after).not.toContain('旧版 wrapper 生成物');
      expect(after).toContain("const PREFIX = ''");
      expect(after).toContain('frame-ancestors');
    } finally {
      await rm(wrapperPath, { force: true });
    }
  });
});

describe('D3（#194）：域名体检两份入口统一拦截', () => {
  it('config.domain 裸名（无点）→ 九步开跑前报人话（含输入复述与「重跑解决不了」提示）', async () => {
    const fake = makeCfRestFake();
    await expect(
      runSteps({
        rootDir: ROOT,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        // CLI --domain= 与配置文件 domain 最终都汇入 configOverride.domain（main.ts applyDecision）
        yes: true,
      configOverride: { domain: 'myteam', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
        http: SMOKE_OK,
      }),
    ).rejects.toThrow(/域名体检未通过[\s\S]*myteam[\s\S]*至少要带一个点/);
    // 拦截发生在九步之前：零请求（连 D1 探测都没跑）
    expect(fake.calls).toHaveLength(0);
  });

  it('config.domain 连续点/非法字符 → 同样人话拒绝', async () => {
    const fake = makeCfRestFake();
    await expect(
      runSteps({
        rootDir: ROOT,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        yes: true,
      configOverride: { domain: 'team..example.com', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
        http: SMOKE_OK,
      }),
    ).rejects.toThrow(/域名体检未通过[\s\S]*空段/);
  });

  it('合法域名照常通过（不误伤正常部署路径）', { timeout: 120_000 }, async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      zones: { 'handywote.top': 'zone-1' },
    });
    await runSteps({
      rootDir: ROOT,
      client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      yes: true,
      configOverride: { domain: 'demo.handywote.top', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
    });
    expect(fake.calls.some((c) => c.url.endsWith('/d1/database'))).toBe(true);
  });
});
