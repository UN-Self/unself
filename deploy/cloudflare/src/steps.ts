// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 幂等九步编排（PRODUCT_SPEC §5.5，#14）：
 * ① 两 D1 → ② 迁移 → ③ Shell Worker → ④ 模块构建/上传/路由绑定（含未选模块路由删除）
 * → ⑤ registry → ⑥ R2 → ⑦ OIDC（无操作，setup 向导录入）→ ⑧ setup token → ⑨ 冒烟。
 * 所有资源查漏后补建：连跑两次收敛（#14 验收）。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import {
  DEPLOY_DIR,
  coreWranglerConfig,
  migrationWranglerConfig,
  moduleWranglerConfig,
  prefixStripWrapperSource,
  provisionAll,
  writeConfig,
  type Provisioned,
} from './assemble';
import { loadUnselfConfig, type ModuleRef, type UnselfConfig } from './config';
import { createKeypair, detectExistingSecret, publicJwksJson, putSecret, JWT_SECRET_NAME } from './keypair';
import {
  ensureTotalTls,
  ensureZoneRecord,
  findAccountId,
  findZone,
  removeLegacyCustomDomains,
  removeModuleRoutes,
} from './dns';
import { ensureDatabases, ensureR2Bucket, validateS3Storage, CORE_DB_NAME, MODULES_DB_NAME } from './provision';
import { registryCommands, sqlString } from './registry';
import { fetchSetupToken, parseWorkersDevFromDeployOutput, smokeCheck } from './smoke';
import type { Wrangler } from './wrangler';

/** 迁移目录（相对各包根）。 */
const CORE_MIGRATIONS_DIR = 'services/core-api/migrations/core';
/** JWKS 端点路径（core-api 契约）。 */
export const JWKS_PATH = '/.well-known/jwks.json';

export interface StepReporter {
  step(n: number, title: string): void;
  log(msg: string): void;
}

export function consoleReporter(): StepReporter {
  return {
    step: (n, title) => console.log(`\n━━━ 步骤（${n}/9）${title}`),
    log: (msg) => console.log(`  ${msg}`),
  };
}

/** 扫描 modules 目录下各 manifest.yaml → ModuleRef[]（选中态按 config.modules 标注）。 */
export async function discoverModules(rootDir: string, selectedIds: string[]): Promise<ModuleRef[]> {
  const { readdir } = await import('node:fs/promises');
  const modulesDir = join(rootDir, 'modules');
  if (!existsSync(modulesDir)) return [];
  const refs: ModuleRef[] = [];
  for (const entry of (await readdir(modulesDir, { withFileTypes: true }))) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(modulesDir, entry.name, 'manifest.yaml');
    if (!existsSync(manifestPath)) continue;
    const text = await readFile(manifestPath, 'utf8');
    const { manifestId } = await import('./config');
    const id = manifestId(text) ?? entry.name;
    refs.push({ id, dir: join(modulesDir, entry.name), selected: selectedIds.includes(id) });
  }
  // 配置里选了但仓库里不存在的模块 → 明确失败（部署半套没人受益）
  const found = new Set(refs.map((r) => r.id));
  for (const id of selectedIds) {
    if (!found.has(id)) {
      throw new Error(`unself.config.jsonc 选中模块 "${id}" 不存在（modules/ 下无该 manifest.yaml）`);
    }
  }
  return refs;
}

/** 多级子域判定：Universal SSL 只覆盖 apex + 一级通配（*.zone），更深的需要 Total TLS。 */
export function needsTotalTls(domain: string, zoneName: string): boolean {
  return domain.split('.').length > zoneName.split('.').length + 1;
}

/** 九步主流程。返回部署摘要（供测试断言与部署输出）。 */
export async function runNineSteps(input: {
  rootDir: string;
  wrangler: Wrangler;
  reporter?: StepReporter;
  /**
   * @internal 仅供测试注入（steps.test.ts）：跳过真实 HTTP（冒烟/setup token）。
   * 生产路径一律走 smoke.ts 的真实实现；smokeCheck 由 smoke.test.ts 直测。
   */
  http?: {
    setupToken(baseUrl: string): Promise<{ token: string; setupUrl: string } | { sealed: true }>;
    smoke(baseUrl: string, moduleIds: string[]): Promise<Array<{ name: string; url: string; ok: boolean; status: number; detail?: string }>>;
  };
  /** 测试注入口：跳过 workers.dev URL 解析（fake wrangler 无真实输出）。 */
  resolveBaseUrl?: (domain: string, workerName: string) => Promise<string>;
  /** 测试注入口：拦截 DNS 自建（默认真实 ensureZoneRecord，读 CLOUDFLARE_API_TOKEN）。 */
  ensureDns?: (domain: string) => Promise<void>;
  /** 测试注入口：拦截 zone 上溯探测（默认真实 findZone，读 CLOUDFLARE_API_TOKEN）。 */
  resolveZone?: (domain: string) => Promise<{ id: string; name: string } | null>;
  /** 测试注入口：拦截遗留 Custom Domain 清理（默认真实 removeLegacyCustomDomains）。 */
  cleanupCustomDomains?: () => Promise<void>;
  /** 测试注入口：拦截未选模块 zone 路由删除（默认真实 removeModuleRoutes）。 */
  cleanupModuleRoutes?: (input: {
    zoneId: string;
    domain: string;
    moduleIds: string[];
    apiToken: string;
    log: (msg: string) => void;
  }) => Promise<void>;
  /** 测试注入口：拦截 Total TLS 开启（默认真实 ensureTotalTls）。 */
  ensureTotalTls?: () => Promise<void>;
  /** 测试注入口：覆盖 unself.config.jsonc（默认 loadUnselfConfig(rootDir)）。 */
  configOverride?: UnselfConfig;
  /** 测试注入口：拦截 secret put（默认走真实 spawn）。 */
  putSecret?: (workerName: string, value: string) => Promise<void>;
  /** 测试注入口：拦截 shell 构建（默认真实 pnpm --filter @unself/shell build；#73 每次部署重建）。 */
  buildShell?: (rootDir: string) => Promise<void>;
  /**
   * @internal 仅供测试注入（steps.test.ts）：跳过公网 JWKS 抓取（fake wrangler 无真实部署）。
   * 生产路径一律走 defaultFetchJwks（真实 fetch GET <baseUrl>/.well-known/jwks.json）。
   */
  fetchJwks?: (baseUrl: string) => Promise<string>;
}): Promise<Summary> {
  const { rootDir, wrangler } = input;
  const rep = input.reporter ?? consoleReporter();
  const config = input.configOverride ?? (await loadUnselfConfig(rootDir));
  validateS3Storage(config);
  const modules = await discoverModules(rootDir, config.modules);
  const selected = modules.filter((m) => m.selected);

  // ① D1
  rep.step(1, '确保 core/modules 两个 D1 存在');
  const dbIds = await ensureDatabases(wrangler, rep.log);

  // ② 迁移（core + 各选中模块；未选模块不动数据）
  rep.step(2, '跑核心迁移与选中模块迁移（表前缀版本化）');
  // 包内 wrangler.jsonc 的 database_id 是占位符 → 迁移用「生成配置」（真实 uuid），migrations_dir 相对配置目录
  const migrateDir = join(rootDir, DEPLOY_DIR, 'migrate');
  const coreMigrateCfg = join(migrateDir, 'core.wrangler.jsonc');
  await writeConfig(coreMigrateCfg, migrationWranglerConfig({
    binding: 'CORE_DB',
    databaseName: CORE_DB_NAME,
    databaseId: dbIds.core,
    migrationsDir: '../../../services/core-api/migrations/core',
  }));
  await wrangler.run(['d1', 'migrations', 'apply', 'CORE_DB', '--remote', '--config', coreMigrateCfg]);
  rep.log('core 迁移已应用（unself-core）');
  for (const mod of selected) {
    const cfg = join(migrateDir, `${mod.id}.wrangler.jsonc`);
    await writeConfig(cfg, migrationWranglerConfig({
      binding: 'MODULES_DB',
      databaseName: MODULES_DB_NAME,
      databaseId: dbIds.modules,
      migrationsDir: `../../../modules/${mod.id}/migrations/${mod.id}`,
    }));
    await wrangler.run(['d1', 'migrations', 'apply', 'MODULES_DB', '--remote', '--config', cfg]);
    rep.log(`模块 ${mod.id} 迁移已应用`);
  }

  // ③ Shell Worker（构建 + 生成配置 + 上传）
  rep.step(3, '构建上传 Shell Worker（壳 + Core API）');
  const provisionInput = {
    rootDir,
    config,
    modules,
    dbIds,
    keypair: { existing: true } as const,
    wrangler,
    buildShell: input.buildShell,
  };
  const provisioned: Provisioned = await provisionAll(provisionInput);

  // 签名密钥：已有 secret 绝不重生成（幂等核心）
  const hasSecret = await detectExistingSecret(wrangler, provisioned.coreName);
  let freshPair: Awaited<ReturnType<typeof createKeypair>> | null = null;
  if (!hasSecret) {
    freshPair = await createKeypair();
    rep.log('未检出 JWT_PRIVATE_KEY：本地生成新 ES256 密钥对（仅本次）');
  } else {
    rep.log('JWT_PRIVATE_KEY 已配置：沿用现有签名密钥');
  }

  // core 部署配置生成（在部署前生成，secret put 需要 Worker 先存在 → 首次先裸部署再补 secret）
  // zone 路径路由的 zone_name 必填：经 API 逐级上溯探测（config 不引入 zone 字段，#59 待定案①）
  let resolvedZone: { id: string; name: string } | null = null;
  if (config.domain) {
    const resolveZone = input.resolveZone ??
      ((domain) => findZone(domain, process.env.CLOUDFLARE_API_TOKEN ?? ''));
    const zone = await resolveZone(config.domain);
    if (!zone) {
      throw new Error(
        `无法解析 "${config.domain}" 归属的 zone：zone 路径路由必需 zone_name（API Token 需该 zone 读权限）`,
      );
    }
    resolvedZone = zone;
    rep.log(`zone 解析：${config.domain} ∈ ${zone.name}`);
    // 旧部署的 Custom Domain 必须显式解绑（wrangler 改路由形态不会自动解绑；
    // 同 host 上 Custom Domain 优先于路径路由，不清理模块路由永远被吞）
    const cleanup = input.cleanupCustomDomains ?? (async () => {
      const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
      const accountId = await findAccountId(token);
      if (!accountId) {
        rep.log('跳过 Custom Domain 清理：无法发现账户（GET /accounts）');
        return;
      }
      await removeLegacyCustomDomains({ accountId, domain: config.domain, apiToken: token, log: rep.log });
    });
    await cleanup();
    // 多级子域不在 Universal SSL 覆盖内：提前触发 Total TLS 签发（幂等）。
    // 一级子域（*.zone）由 Universal SSL 通配证书覆盖，无需 Total TLS（且免费计划无 ACM 会报 1450）
    const needsTls = needsTotalTls(config.domain, zone.name);
    const totalTls = input.ensureTotalTls ?? (async () => {
      if (!needsTls) {
        rep.log(`跳过 Total TLS：${config.domain} 为一级子域（Universal SSL 覆盖）`);
        return;
      }
      await ensureTotalTls({
        zoneId: zone.id,
        apiToken: process.env.CLOUDFLARE_API_TOKEN ?? '',
        log: rep.log,
      });
    });
    await totalTls();
  }
  await writeConfig(
    join(provisioned.outDir, 'core.wrangler.jsonc'),
    coreWranglerConfig({ config, dbIds, coreName: provisioned.coreName, zoneName: resolvedZone?.name }),
  );
  await writeFileIfMissing(
    join(provisioned.outDir, 'core-worker.js'),
    coreWorkerEntrySource(provisioned.outDir, rootDir),
  );
  await wrangler.run(['deploy', '--config', join(provisioned.outDir, 'core.wrangler.jsonc')]);
  if (freshPair) {
    if (input.putSecret) {
      await input.putSecret(provisioned.coreName, freshPair.privateKeyPem);
      rep.log('写入 secret JWT_PRIVATE_KEY（测试注入口）');
    } else {
      await putSecretStdin({
        wranglerBin: wranglerBin(rootDir),
        rootDir,
        workerName: provisioned.coreName,
        value: freshPair.privateKeyPem,
        log: rep.log,
      });
    }
    // secret put 会触发重新部署使 secret 生效
    await wrangler.run(['deploy', '--config', join(provisioned.outDir, 'core.wrangler.jsonc')]);
  }
  if (config.domain) {
    // core 改 zone 路径路由后 Custom Domain 被解绑、CF 删其自建 DNS 记录——
    // 补一条代理 A 记录（幂等）。必须在模块部署与冒烟之前（主域可解析）。
    const ensureDns = input.ensureDns ?? ((domain) =>
      ensureZoneRecord({
        domain,
        zone: resolvedZone ?? undefined,
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
        log: rep.log,
      }));
    await ensureDns(config.domain);
  }
  const baseUrl = await resolveBaseUrl(
    input,
    config.domain ?? '',
    join(provisioned.outDir, provisioned.coreConfig),
    wrangler,
    rep,
  );
  provisioned.baseUrl = baseUrl;

  // ④ 模块构建/上传/路由绑定
  rep.step(4, '构建上传模块 Worker，绑 <domain>/m/<id>/* 路由（zone 路径）与存储绑定');
  // 签名公钥：部署期一次性解析，注入各模块 vars.CORE_JWKS_JSON（模块本地验签，零运行时网络）。
  // 两级取钥（#71 根因①）：本运行刚生成 keypair（首部署）→ 用内存公钥，绝不抓取公网；
  // 已有 secret → 公网抓取 core JWKS（部署器在公网，无 CF 同 zone 禁令问题），抓取失败即硬报错。
  let jwksJson: string;
  if (freshPair) {
    jwksJson = publicJwksJson(freshPair);
    rep.log('首部署：使用本运行生成的公钥');
  } else {
    const fetchJwks = input.fetchJwks ?? defaultFetchJwks;
    try {
      jwksJson = await fetchJwks(baseUrl);
    } catch (err) {
      throw new Error(
        `无法获取 Core 公钥（${baseUrl}${JWKS_PATH}）：${err instanceof Error ? err.message : String(err)}；` +
          'DNS/路由可能尚未就绪，可重跑部署（幂等）',
      );
    }
    rep.log('已获取 Core 公钥 JWKS（部署期注入模块 vars）');
  }
  for (const mod of provisioned.modules) {
    await writeConfig(
      join(provisioned.outDir, `modules/${mod.id}.wrangler.jsonc`),
      moduleWranglerConfig({
        config,
        dbIds: { modules: dbIds.modules },
        mod,
        jwksJson,
        zoneName: resolvedZone?.name,
      }),
    );
    // wrapper 每次重写（内容确定，幂等）：它独占 worker.js（main 入口），bundle 在 app.js
    await writeConfig(
      join(provisioned.outDir, `modules/${mod.id}/worker.js`),
      prefixStripWrapperSource(mod.id),
    );
    await wrangler.run(['deploy', '--config', join(provisioned.outDir, `modules/${mod.id}.wrangler.jsonc`)]);
    rep.log(`模块 ${mod.id} 已部署（zone 路径路由 /m/${mod.id}/*）`);
  }

  // ④′ 未选模块（config.modules 未列出但已存在）：删除其 zone 路由 /m/<id>/*。
  // M0 验收（requirements L207）「移除模块重部署后路由消失」：只删路由——不删模块 Worker、
  // 不动模块 D1（数据保留；完整卸载剧本见 §5.4，属 M1）。注册表翻转 enabled=0 在步骤⑤。
  const unselected = modules.filter((m) => !m.selected);
  if (unselected.length > 0) {
    const unselectedIds = unselected.map((m) => m.id);
    if (!config.domain || !resolvedZone) {
      rep.log(`跳过未选模块路由删除（未配置 domain，无 zone 路由）：${unselectedIds.join('、')}`);
    } else {
      const cleanupRoutes = input.cleanupModuleRoutes ?? removeModuleRoutes;
      await cleanupRoutes({
        zoneId: resolvedZone.id,
        domain: config.domain,
        moduleIds: unselectedIds,
        apiToken: process.env.CLOUDFLARE_API_TOKEN ?? '',
        log: rep.log,
      });
    }
  }

  // ⑤ registry 写入
  rep.step(5, '注册表写入（选中 enabled，未选 not_deployed）');
  const manifestTexts: Record<string, string> = {};
  for (const mod of modules) {
    manifestTexts[mod.id] = await readFile(join(mod.dir, 'manifest.yaml'), 'utf8');
  }
  for (const cmd of registryCommands({ config, modules, baseUrl, manifestTexts })) {
    // wrangler v4 d1 execute 无 --param：binds 以 SQL 字符串字面量内联（单引号翻倍转义）
    const sql = cmd.binds?.length ? inlineParams(cmd.sql, cmd.binds) : cmd.sql;
    // module_registry 在 core 库（core 迁移 0001 建），不是 modules 库
    await wrangler.run(
      ['d1', 'execute', CORE_DB_NAME, '--command', sql, '-y', '--remote', '--json'],
      { silent: true },
    );
    rep.log(cmd.description);
  }

  // ⑥ R2 / S3
  rep.step(6, '建 R2 桶或接收外部 S3 参数');
  if (config.storage.provider === 'r2') {
    await ensureR2Bucket(wrangler, config.storage.bucket, rep.log);
  } else {
    rep.log(`外部 S3：endpoint=${config.storage.endpoint} bucket=${config.storage.bucket}（不建桶）`);
  }

  // ⑦ OIDC（无操作）
  rep.step(7, 'OIDC 配置（不在脚本/配置文件中——部署后在 setup 向导填写）');
  rep.log('跳过：OIDC 凭证由部署者在 setup 向导录入，存 core 库（§5.5 已知缺口见 spec）');

  // ⑧ setup token
  rep.step(8, '生成一次性 setup token');
  const setup = input.http
    ? await input.http.setupToken(baseUrl)
    : await fetchSetupToken({ baseUrl, log: rep.log });

  // ⑨ 冒烟
  rep.step(9, '冒烟检查 /api/health 与各模块 health');
  const smoke = input.http
    ? await input.http.smoke(baseUrl, selected.map((m) => m.id))
    : await smokeCheck({
        baseUrl,
        moduleIds: selected.map((m) => m.id),
      });
  for (const r of smoke) {
    rep.log(`${r.ok ? '✓' : '✗'} ${r.name} → ${r.url}${r.detail ? `（${r.detail}）` : ''}`);
  }
  const failed = smoke.filter((r) => !r.ok);
  if (failed.length > 0) {
    throw new Error(`冒烟失败：${failed.map((f) => f.name).join('、')}（详情见上方）`);
  }

  return {
    baseUrl,
    core: { name: provisioned.coreName, config: provisioned.coreConfig },
    modules: provisioned.modules.map((m) => ({ id: m.id, config: m.config })),
    d1: dbIds,
    r2Bucket: provisioned.r2Bucket,
    setup: 'sealed' in setup ? { sealed: true as const } : { setupUrl: setup.setupUrl },
    keypairAction: freshPair ? 'created' : 'existing',
  };
}

/** baseUrl 决策：config.domain 优先；否则重放一次幂等 deploy 从其 stdout 抓 workers.dev（wrangler v4 仅在真实部署输出中给出 URL）。 */
async function resolveBaseUrl(
  input: { resolveBaseUrl?: (domain: string, workerName: string) => Promise<string>; http?: unknown },
  domain: string,
  coreConfigPath: string,
  wrangler: Wrangler,
  rep: StepReporter,
): Promise<string> {
  if (input.resolveBaseUrl) {
    return input.resolveBaseUrl(domain, coreConfigPath);
  }
  if (domain) {
    return `https://${domain}`;
  }
  rep.log('未配置 domain：以 workers.dev 域名对外（unself.config.jsonc domain 留空）');
  const res = await wrangler.tryRun(['deploy', '--config', coreConfigPath]);
  const url = parseWorkersDevFromDeployOutput(res.stdout);
  if (!url) {
    throw new Error('无法从 wrangler 输出解析 workers.dev 域名；请在 unself.config.jsonc 配置 domain');
  }
  return url;
}

/** 公网抓取 core JWKS（部署器在公网，无 CF 同 zone 禁令）；非 2xx 或形状非法（无 keys 数组/空）→ 抛错。 */
async function defaultFetchJwks(baseUrl: string): Promise<string> {
  const url = `${baseUrl}${JWKS_PATH}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → HTTP ${res.status}`);
  }
  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error(`GET ${url} → JWKS 形状非法（无 keys 数组或为空）`);
  }
  return JSON.stringify(body);
}

/** secret put（stdin 喂值）：正式部署路径；测试以注入 fake Wrangler 时不会走到此处之外的真实 spawn——
 *  幂等收敛测试首跑带 freshPair，也需要 put。为了让 fake 账户可测，提供 spy 挂点：
 *  单测通过 env UNSELF_SKIP_SECRET_PUT=1 跳过真实 spawn（fake 状态由测试自记）。 */
function putSecretStdin(input: {
  wranglerBin: string;
  rootDir: string;
  workerName: string;
  value: string;
  log: (msg: string) => void;
}): Promise<void> {
  if (process.env.UNSELF_SKIP_SECRET_PUT === '1') {
    input.log(`[skip] 写入 secret ${JWT_SECRET_NAME} → ${input.workerName}（UNSELF_SKIP_SECRET_PUT=1）`);
    return Promise.resolve();
  }
  return putSecret(input.wranglerBin, input.rootDir, input.workerName, input.value, input.log);
}

function wranglerBin(rootDir: string): string {
  const local = join(rootDir, 'node_modules', '.bin', 'wrangler');
  return existsSync(local) ? local : 'wrangler';
}

/** 把 ?N 占位符替换为 SQL 字符串字面量（wrangler v4 无 --param 时的等价内联）。 */
function inlineParams(sql: string, binds: unknown[]): string {
  let out = sql;
  binds.forEach((bind, i) => {
    const literal = typeof bind === 'number' ? String(bind) : sqlString(String(bind));
    out = out.replace(new RegExp(`\\?${i + 1}`, 'g'), literal);
  });
  return out;
}

async function writeFileIfMissing(path: string, content: string): Promise<void> {
  if (!existsSync(path)) {
    await writeConfig(path, content);
  }
}

/** core Worker 入口：core-api 优先；未命中（HTML 导航）回退 ASSETS 的 SPA。相对路径按生成文件目录（.deploy/cloudflare/）计。 */
export function coreWorkerEntrySource(outDir: string, rootDir: string): string {
  const rel = relative(outDir, join(rootDir, 'services/core-api/src/index.ts'));
  return `// SPDX-License-Identifier: AGPL-3.0-only
// 由 deploy/cloudflare 生成：core-api Hono app + 未命中路径回退 SPA 资产。
import app from '${rel.replaceAll("\\", "/")}';

export default {
  async fetch(request, env, ctx) {
    const res = await app.fetch(request, env, ctx);
    if (res.status !== 404 || !env.ASSETS) return res;
    // API/生命周期路径保持 JSON 404；页面导航回退 SPA
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/life/') ||
        url.pathname.startsWith('/.well-known/') || !request.method ||
        request.method !== 'GET') {
      return res;
    }
    return env.ASSETS.fetch(new URL('/', url.origin).toString(), request);
  },
};
`;
}

export interface Summary {
  baseUrl: string;
  core: { name: string; config: string };
  modules: Array<{ id: string; config: string }>;
  d1: { core: string; modules: string };
  r2Bucket?: string;
  setup: { sealed: true } | { setupUrl: string };
  keypairAction: 'created' | 'existing';
}

export { CORE_DB_NAME, MODULES_DB_NAME, DEPLOY_DIR };
