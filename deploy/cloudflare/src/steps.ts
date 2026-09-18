// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 幂等九步编排（PRODUCT_SPEC §5.5，#14；#244 REST 化）：
 * ① 两 D1（chat 选中时含专属 D1/KV/R2）→ ② 迁移（REST import + 按模块独立记账）
 * → ③ Shell Worker → ④ 模块构建/上传/路由绑定（assets 直传 + secret；未选模块路由删除）
 * → ⑤ registry（ControlPlane）→ ⑥ R2 → ⑦ OIDC（无操作）→ ⑧ 本地签发 setup token（ControlPlane）
 * → ⑨ 冒烟 + 主题体检。
 * 所有资源查漏后补建：连跑两次收敛（#14 验收）。全程不安装、不调用 wrangler（决策 #65）。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { probeSqlite } from '@unself/control-plane';
import {
  DEPLOY_DIR,
  bundleCoreWorker,
  coreWranglerConfig,
  moduleWranglerConfig,
  prefixStripWrapperSource,
  provisionAll,
  writeConfig,
  type Provisioned,
} from './assemble';
import { loadUnselfConfig, moduleIds, normalizeModuleEntries, type ModuleRef, type NormalizedModuleEntry, type UnselfConfig } from './config';
import { CONTRACT_VERSION, ModuleManifestSchema } from '@unself/contracts';
import { LOCK_FILENAME, emptyLock, parseLockText, serializeLock, manifestHashOf, type LockFile } from './lock';
import { lockRecordFrom, resolveSources } from './module-sources';
import { createCoreControlPlane } from './control-plane';
import { CredentialsMissingError, credentialsMissingMessage, resolveAuth } from './auth';
import { domainProblem } from './interactive';
import { createKeypair, JWT_SECRET_NAME, publicJwksJson } from './keypair';
import { ensureRoute, ensureTotalTls, ensureZoneARecord, findZone, removeLegacyCustomDomains, removeRoutesForPatterns } from './rest/zones';
import { ensureDatabases, validateS3Storage, CORE_DB_NAME, MODULES_DB_NAME } from './provision';
import { ensureD1 } from './rest';
import {
  RestClient,
  findAccountId,
  putWorker,
  hasWorkerSecret,
  putWorkerSecret,
  isWorkerNew,
  enableWorkersDev,
  ensureR2Bucket,
  workersDevSubdomain,
} from './rest';
import { buildAssetManifest, startAssetSession, uploadMissingAssets } from './rest/assets';
import type { WorkerBinding } from './rest/workers';
import {
  applyChatSchema,
  CHAT_DB_NAME,
  CHAT_KEYRING_SECRET,
  CHAT_MODULE_ID,
  CHAT_KV_NAME,
  CHAT_R2_NAME,
  chatWranglerConfig,
  ensureChatResources,
  ensureChatR2Bucket,
  generateChatKeyring,
  readChatPackageConfig,
} from './chat-provision';
import {
  checkSharedGuards,
  dedicatedDbNameFor,
  migrationDirFor,
  migrationFailure,
  readSqlFiles,
  storageLevelFor,
} from './migrate';
import { buildChatFrontendAssets } from './chat-frontend';
import { buildManifestSnapshot } from './registry';
import { checkModuleThemes, smokeCheck } from './smoke';
import type { ThemeCheckResult } from './smoke';
import { generateSetupToken } from './smoke';

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

/**
 * 模块发现：
 * - builtin 条目（无 source）→ 扫描 modules 目录（manifest.yaml，存量路径）；
 * - sourced 条目（{id, source}）→ 来源解析器取包落位（远端 tarball 直解/file: 本地目录），
 *   包根即当 module 目录（步骤②迁移/④装配/⑤注册表共用）。
 * sourced 解析需要 outDir（步骤③前里立）——这里先只注册 source 侧表；实际取包延后到步骤③内
 * （provisionAll 之前的 ensureSourcedModules）。
 */
export async function discoverModules(
  rootDir: string,
  selectedIds: string[],
  entries?: NormalizedModuleEntry[],
): Promise<ModuleRef[]> {
  const sourcedEntries = (entries ?? []).filter((e): e is NormalizedModuleEntry & { source: string } => !!e.source);
  const { readdir } = await import('node:fs/promises');
  const modulesDir = join(rootDir, 'modules');
  const refs: ModuleRef[] = [];
  if (existsSync(modulesDir)) {
    for (const entry of (await readdir(modulesDir, { withFileTypes: true }))) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(modulesDir, entry.name, 'manifest.yaml');
      if (!existsSync(manifestPath)) continue;
      const text = await readFile(manifestPath, 'utf8');
      const { manifestId } = await import('./config');
      const id = manifestId(text) ?? entry.name;
      // config 里同 id 带了 source → sourced 条目优先（目录扫描不产出该 id）
      if (sourcedEntries.some((s) => s.id === id)) continue;
      refs.push({ id, dir: join(modulesDir, entry.name), selected: selectedIds.includes(id) });
    }
  }
  // sourced 条目：占位（dir 在 ensureSourcedModules 取包后回填）
  for (const s of sourcedEntries) {
    refs.push({ id: s.id, dir: '', selected: selectedIds.includes(s.id), source: s.source });
  }
  // 配置里选了但仓库里不存在的 builtin 模块 → 明确失败（部署半套没人受益）
  const found = new Set(refs.map((r) => r.id));
  for (const id of selectedIds) {
    if (!found.has(id)) {
      throw new Error(`unself.config.jsonc 选中模块 "${id}" 不存在（modules/ 下无该 manifest.yaml，且 config 未提供 source）`);
    }
  }
  return refs;
}

/** 多级子域判定：Universal SSL 只覆盖 apex + 一级通配（*.zone），更深的需要 Total TLS。 */
export function needsTotalTls(domain: string, zoneName: string): boolean {
  return domain.split('.').length > zoneName.split('.').length + 1;
}

/** 部署期 worker 上传描述（由装配器构建产物组装）。 */
interface WorkerUploadSpec {
  name: string;
  mainModule: string;
  modules: Array<{ name: string; content: string }>;
  bindings: Array<Record<string, unknown>>;
  compatibilityDate: string;
  compatibilityFlags: string[];
  observability: boolean;
  /** 静态资产目录（绝对路径）与 ASSETS 绑定名；无资产 undefined。 */
  assets?: { dir: string; binding: string; htmlHandling?: string; notFoundHandling: string; runWorkerFirst: boolean | string[] };
  /** DO 迁移（chat：首部署建 SQLite 类）。 */
  migrations?: { oldTag?: string; newTag: string; steps: Array<Record<string, unknown>> };
}

export interface StepDeps {
  /** REST 客户端（默认 CLOUDFLARE_API_TOKEN → 借 wrangler OAuth）。 */
  client?: RestClient;
  /** 覆盖账户解析（测试注入）。 */
  accountId?: string;
}

/** 九步主流程。返回部署摘要（供测试断言与部署输出）。 */
export async function runNineSteps(input: {
  rootDir: string;
  /** REST 客户端（测试注入替身；缺省由凭证解析新建）。 */
  client?: RestClient;
  reporter?: StepReporter;
  /**
   * @internal 仅供测试注入（steps.test.ts）：跳过真实 HTTP（冒烟/主题体检）。
   * 生产路径一律走 smoke.ts 的真实实现；smokeCheck/checkModuleThemes 由 smoke.test.ts 直测。
   */
  http?: {
    smoke(baseUrl: string, moduleIds: string[]): Promise<Array<{ name: string; url: string; ok: boolean; status: number; detail?: string }>>;
    /** 可选：主题体检注入（§6.5.8）。缺省 = 跳过（保持既有测试语义，不请求网络）。 */
    themeCheck?: (baseUrl: string, moduleIds: string[]) => Promise<ThemeCheckResult[]>;
  };
  /** 测试注入口：跳过 workers.dev URL 解析。 */
  resolveBaseUrl?: (domain: string, workerName: string) => Promise<string>;
  /** 测试注入口：拦截 zone 上溯探测（默认真实 findZone）。 */
  resolveZone?: (domain: string) => Promise<{ id: string; name: string } | null>;
  /** 测试注入口：拦截遗留 Custom Domain 清理（默认真实 removeLegacyCustomDomains）。 */
  cleanupCustomDomains?: () => Promise<void>;
  /** 测试注入口：拦截未选模块 zone 路由删除（默认真实 removeRoutesForPatterns）。 */
  cleanupModuleRoutes?: (input: {
    zoneId: string;
    domain: string;
    moduleIds: string[];
    log: (msg: string) => void;
  }) => Promise<void>;
  /** 测试注入口：拦截 Total TLS 开启（默认真实 ensureTotalTls）。 */
  ensureTotalTls?: () => Promise<void>;
  /** 测试注入口：覆盖 unself.config.jsonc（默认 loadUnselfConfig(rootDir)）。 */
  configOverride?: UnselfConfig;
  /** 测试注入口：拦截 secret put（secretName 区分 core JWT 与 chat 密钥环）。 */
  putSecret?: (workerName: string, value: string, secretName: string) => Promise<void>;
  /** 测试注入口：拦截 shell 构建（默认真实 pnpm --filter @unself/shell build；#73 每次部署重建）。 */
  buildShell?: (rootDir: string) => Promise<void>;
  /** 测试注入口：拦截 chat 前端构建（默认真实 vite build；返回产物相对 outDir/modules/ 路径）。 */
  buildChatFrontend?: (input: { rootDir: string; outDir: string; log: (msg: string) => void }) => Promise<string>;
  /**
   * @internal 仅供测试注入（steps.test.ts）：跳过公网 JWKS 抓取。
   * 生产路径一律走 defaultFetchJwks（真实 fetch GET <baseUrl>/.well-known/jwks.json）。
   */
  fetchJwks?: (baseUrl: string) => Promise<string>;
  /** 测试注入口：拦截 worker 上传（默认真实 putWorker + assets 直传）。 */
  uploadWorker?: (upload: WorkerUploadSpec) => Promise<void>;
  /** 漂移已确认（-y / 交互确认后）；有漂移未确认 → 来源解析直接报错列 diff（#245）。 */
  yes?: boolean;
  /** @internal 测试注入口（module-sources-install.test.ts）：替换远端抓取（形状同 module-sources 内 fetchers）。 */
  fetchers?: Parameters<typeof resolveSources>[0]['fetchers'];
  /** @internal 测试注入口：预置 unself.lock 内容（#245 来源测试）。 */
  preLock?: string;
  /** 测试注入口：拦截 DNS 自建（默认真实 ensureZoneARecord，#244 前的步骤顺序保留）。 */
  ensureDns?: (domain: string) => Promise<void>;
}): Promise<Summary> {
  const { rootDir } = input;
  const rep = input.reporter ?? consoleReporter();
  const config = input.configOverride ?? (await loadUnselfConfig(rootDir));
  // 域名体检（#194 D3）：CLI --domain= 与配置文件 domain 都汇入 config.domain，此处统一拦截。
  if (config.domain) {
    const problem = domainProblem(config.domain);
    if (problem) {
      throw new Error(
        `域名体检未通过（来源 --domain= 参数或 unself.config.jsonc domain，交互输入已在开屏前拦截）：${problem}——重跑解决不了拼写，先改输入`,
      );
    }
  }
  const entries = normalizeModuleEntries(config.modules);
  const modules = await discoverModules(rootDir, moduleIds(entries), entries);
  const selected = modules.filter((m) => m.selected);
  validateS3Storage(config);
  /** chat 密钥环动作（选中 chat 时在步骤④赋值；未选中 undefined）。 */
  let chatKeyringAction: 'created' | 'existing' | undefined;

  const client = input.client ?? await defaultClient(rep.log);

  // ① D1（chat 选中时：包配置先过一道形状检查，再补建专属 D1/KV/R2）
  rep.step(1, '确保 core/modules 两个 D1 存在（chat 选中时含专属 D1/KV/R2）');
  const accountId = await findAccountId(client);
  if (!accountId) throw new Error('无法解析 CF 账户（GET /accounts 失败或为空）——检查凭证');
  const dbIds = await ensureDatabases(client, accountId, rep.log);
  const chatMod = selected.find((m) => m.id === CHAT_MODULE_ID);
  let chatResources: { dbId: string; kvId: string } | null = null;
  let chatPkg: Awaited<ReturnType<typeof readChatPackageConfig>> | null = null;
  if (chatMod) {
    chatPkg = await readChatPackageConfig(chatMod.dir);
    chatResources = await ensureChatResources(client, accountId, rep.log);
    await ensureChatR2Bucket(client, accountId, rep.log);
  }

  // ② 迁移与数据落点（#248 四级）：core→无迁移；shared→共享库建表（三护栏硬校验）；
  //    dedicated→独立 D1 建表；external→接线归模块（连接串走配置页），装配器不碰。
  //    记账隔离：applyMigrations(module, …) → unself_migrations_<module>（#55 护栏①）。
  //    失败处理（#61）：停住并指出「模块 / 文件 / 第几条语句」，不自动重试、不自动回滚。
  rep.step(2, '跑核心迁移与选中模块迁移（按模块独立记账，REST import）');
  const coreCp = createCoreControlPlane(client, accountId, dbIds.core);
  const coreMigrationDir = join(rootDir, 'services/core-api/migrations/core');
  await coreCp.applyMigrations('core', await readSqlFiles(coreMigrationDir));
  rep.log('core 迁移已应用（unself-core，记账 unself_migrations_core）');
  /** dedicated 模块的独立 D1 id（步骤①补建；摘要与绑定共用）。 */
  const dedicatedDbIds = new Map<string, string>();
  for (const mod of selected) {
    const level = storageLevelFor({ manifest: mod.resolved?.manifest, id: mod.id });
    if (mod.id === CHAT_MODULE_ID && chatResources && chatPkg) {
      // chat（#74 普通化 = dedicated 普通实例）：基线 schema 一次性灌入保留（#219 决策，上游无记账迁移链）
      await applyChatSchema({ client, accountId, chatDbId: chatResources.dbId, moduleDir: mod.dir, log: rep.log });
      dedicatedDbIds.set(mod.id, chatResources.dbId);
      continue;
    }
    if (level === 'core') {
      rep.log(`模块 ${mod.id} 落点 core：数据经 Core API 代理，无模块建表`);
      continue;
    }
    if (level === 'external') {
      rep.log(`模块 ${mod.id} 落点 external：自备外部库，装配器不接线（连接串走配置页）`);
      continue;
    }
    const migDir = migrationDirFor(mod.dir, mod.id);
    const files = await readSqlFiles(migDir);
    if (files.length === 0) {
      throw new Error(
        `模块 ${mod.id} 落点 ${level}（自建表）但包内没有 migrations/${mod.id}/ 迁移文件——装一半的库没人受益，先补迁移再装`,
      );
    }
    const manifest = mod.resolved?.manifest;
    const tables = manifest?.tables ?? [];
    if (level === 'shared') {
      // shared 三护栏③：命名前缀 + 禁止跨模块外键（装配时硬校验，违者停住）；
      // 护栏②（tables 申报）在契约 schema 已拦，这里对实际建的表再兜一道。
      if (tables.length === 0) {
        throw new Error(
          `模块 ${mod.id} 落点 shared 但未申报 tables 表名清单（护栏②）——共享库不接收未经申报的表`,
        );
      }
      const problems = checkSharedGuards({ moduleId: mod.id, tables, migrations: files });
      if (problems.length > 0) {
        throw new Error(
          `模块 ${mod.id} 未通过 shared 三护栏硬校验：\n${problems.map((p) => `  - ${p}`).join('\n')}`,
        );
      }
    }
    let targetDbId = dbIds.modules;
    if (level === 'dedicated') {
      targetDbId = dedicatedDbIds.get(mod.id) ?? (await ensureD1(client, accountId, dedicatedDbNameFor(mod.id), rep.log));
      dedicatedDbIds.set(mod.id, targetDbId);
      rep.log(`模块 ${mod.id} 落点 dedicated：独立库 ${dedicatedDbNameFor(mod.id)}（${targetDbId}）`);
    } else {
      rep.log(`模块 ${mod.id} 落点 shared：共享 modules 库建表（独立记账 ${`unself_migrations_${mod.id.replaceAll('-', '_')}`}）`);
    }
    const modulesCp = createCoreControlPlane(client, accountId, targetDbId);
    // 逐文件带定位地跑：applyMigrations 内部按记账跳过；失败转「模块/文件/第几条语句」人话。
    try {
      const report = await modulesCp.applyMigrations(mod.id, files);
      rep.log(
        `模块 ${mod.id} 迁移：本次应用 ${report.applied.length} 个${report.skipped.length > 0 ? `，记账跳过 ${report.skipped.length} 个` : ''}`,
      );
    } catch (err) {
      // 逐文件重放定位：找到第一份「记账上未应用」的文件再跑一次，捕原始错误转三要素
      const applied = await modulesCp.appliedMigrations(mod.id);
      const pending = files.filter((f) => !applied.includes(f.name));
      for (const file of pending) {
        try {
          await modulesCp.applyMigrations(mod.id, [file]);
        } catch (fileErr) {
          throw migrationFailure({ moduleId: mod.id, file: file.name, sql: file.sql, cause: fileErr });
        }
      }
      // 逐文件重放全部成功（竞态/瞬时差异）→ 保留原始错误上下文人话化
      throw migrationFailure({ moduleId: mod.id, file: pending[pending.length - 1]?.name ?? '(未知)', sql: pending[pending.length - 1]?.sql ?? '', cause: err });
    }
  }
  // node:sqlite 探测（Docker 落点可用性预检；不可用给人话不崩——仅提示，不阻断 CF 部署）
  const sqlite = probeSqlite();
  rep.log(sqlite.usable ? `node:sqlite 可用（${sqlite.version}）：Docker 模块落点就绪` : `node:sqlite 不可用：${sqlite.reason.split('\n')[0]}（Docker 落点暂不可用，CF 部署不受影响）`);

  // ②½ 来源解析（#245）：sourced 模块取包/复用 lock + 完整性校验；builtin 直接登记 lock（决策 #60）。
  // outDir 此时尚未创建（provisionAll 建）——手动先建：module-sources 暂存区要落盘。
  const outDirPre = join(rootDir, DEPLOY_DIR);
  const { mkdir: mkdirPre } = await import('node:fs/promises');
  await mkdirPre(outDirPre, { recursive: true });
  const lockPath = join(rootDir, LOCK_FILENAME);
  let lock: LockFile = emptyLock();
  if (input.preLock !== undefined) {
    lock = parseLockText(input.preLock);
  } else if (existsSync(lockPath)) {
    lock = parseLockText(await readFile(lockPath, 'utf8'));
  }
  const sourcedEntries = entries.filter((e): e is NormalizedModuleEntry & { source: string } => !!e.source);
  let resolution: Awaited<ReturnType<typeof resolveSources>> | null = null;
  if (sourcedEntries.length > 0) {
    resolution = await resolveSources({
      rootDir,
      outDir: outDirPre,
      entries: sourcedEntries,
      lock,
      confirmed: input.yes,
      log: rep.log,
      ...(input.fetchers ? { fetchers: input.fetchers as Parameters<typeof resolveSources>[0]['fetchers'] } : {}),
    });
    for (const mod of resolution.sourced) {
      const ref = modules.find((m) => m.id === mod.id);
      if (ref) {
        ref.dir = mod.packageDir;
        ref.resolved = mod;
      }
    }
  }
  // lock 记录（决策 #60「builtin 也进 lock」）：sourced 由解析产物生成；builtin 从 manifest.yaml 提取。
  // 只有本次 config 声明的模块进 lock（removed 的旧记录随 resolution.removed 删掉）。
  const lockModules: LockFile['modules'] = {};
  for (const mod of modules.filter((m) => m.selected && !m.source)) {
    const yaml = await readFile(join(mod.dir, 'manifest.yaml'), 'utf8');
    const manifest = ModuleManifestSchema.parse(buildManifestSnapshot({ manifestText: yaml, moduleId: mod.id, baseUrl: '' }));
    lockModules[mod.id] = {
      source: `builtin:${mod.id}`,
      version: manifest.version,
      manifestHash: manifestHashOf(manifest),
      contractVersion: CONTRACT_VERSION,
    };
  }
  for (const mod of resolution?.sourced ?? []) {
    lockModules[mod.id] = lockRecordFrom(mod);
  }

  // ③ Shell Worker（构建 + 上传）
  rep.step(3, '构建上传 Shell Worker（壳 + Core API）');
  const provisionInput = {
    rootDir,
    config,
    modules,
    dbIds,
    buildShell: input.buildShell,
  };
  const provisioned: Provisioned = await provisionAll(provisionInput);

  // 签名密钥：已有 secret 绝不重生成（幂等核心）
  const hasSecret = await hasWorkerSecret(client, accountId, provisioned.coreName, JWT_SECRET_NAME);
  let freshPair: Awaited<ReturnType<typeof createKeypair>> | null = null;
  if (!hasSecret) {
    freshPair = await createKeypair();
    rep.log('未检出 JWT_PRIVATE_KEY：本地生成新 ES256 密钥对（仅本次）');
  } else {
    rep.log('JWT_PRIVATE_KEY 已配置：沿用现有签名密钥');
  }

  // zone 解析（路由/DNS/Total TLS 前置）
  let resolvedZone: { id: string; name: string } | null = null;
  if (config.domain) {
    const resolveZone = input.resolveZone ??
      ((domain) => findZone(client, domain));
    const zone = await resolveZone(config.domain);
    if (!zone) {
      throw new Error(`无法解析 "${config.domain}" 归属的 zone：zone 路径路由必需 zone_name（token 需该 zone 读权限）`);
    }
    resolvedZone = zone;
    rep.log(`zone 解析：${config.domain} ∈ ${zone.name}`);
    const cleanup = input.cleanupCustomDomains ?? (async () => {
      await removeLegacyCustomDomains(client, accountId, config.domain, rep.log);
    });
    await cleanup();
    const needsTls = needsTotalTls(config.domain, zone.name);
    const totalTls = input.ensureTotalTls ?? (async () => {
      if (!needsTls) {
        rep.log(`跳过 Total TLS：${config.domain} 为一级子域（Universal SSL 覆盖）`);
        return;
      }
      await ensureTotalTls(client, zone.id, rep.log);
    });
    await totalTls();
  }
  await writeConfig(
    join(provisioned.outDir, 'core.wrangler.jsonc'),
    coreWranglerConfig({ config, dbIds, coreName: provisioned.coreName, zoneName: resolvedZone?.name }),
  );
  await writeConfig(
    join(provisioned.outDir, 'core-worker.js'),
    coreWorkerEntrySource(provisioned.outDir, rootDir),
  );
  // 入口模板落盘后立即自打包（wrangler 隐式 bundle 的替代；探针实证顺序反了会打到陈旧入口）
  await bundleCoreWorker(
    join(provisioned.outDir, 'core-worker.js'),
    join(provisioned.outDir, 'core-worker.bundle.js'),
  );
  // core 上传描述（secret 首部署后补写 → 同描述重传一次；幂等收敛）
  const coreVars: Record<string, string> = {};
  if (config.domain) coreVars.UNSELF_BASE_URL = `https://${config.domain}`;
  const coreSpec: WorkerUploadSpec = {
    name: provisioned.coreName,
    mainModule: 'core-worker.bundle.js',
    modules: [{ name: 'core-worker.bundle.js', content: await readFile(join(provisioned.outDir, 'core-worker.bundle.js'), 'utf8') }],
    bindings: [
      { type: 'd1', name: 'CORE_DB', id: dbIds.core },
      { type: 'd1', name: 'MODULES_DB', id: dbIds.modules },
      { type: 'assets', name: 'ASSETS' },
      ...Object.entries(coreVars).map(([k, v]) => ({ type: 'plain_text', name: k, text: v })),
    ],
    compatibilityDate: '2026-09-01',
    compatibilityFlags: ['nodejs_compat'],
    observability: true,
    assets: {
      dir: join(provisioned.outDir, 'assets/shell'),
      binding: 'ASSETS',
      notFoundHandling: 'single-page-application',
      runWorkerFirst: ['/api/*', '/.well-known/*', '/setup*'],
    },
  };
  await uploadWorkerSpec(input, client, accountId, rep, coreSpec);
  rep.log('Shell Worker 已上传');
  if (freshPair) {
    if (input.putSecret) {
      await input.putSecret(provisioned.coreName, freshPair.privateKeyPem, JWT_SECRET_NAME);
      rep.log('写入 secret JWT_PRIVATE_KEY（测试注入口）');
    } else {
      await putWorkerSecret(client, accountId, provisioned.coreName, JWT_SECRET_NAME, freshPair.privateKeyPem);
      rep.log('写入 secret JWT_PRIVATE_KEY');
    }
    // secret put 触发重新部署使 secret 生效（同产物重传；资产会话按哈希去重，二传零文件上传）
    await uploadWorkerSpec(input, client, accountId, rep, coreSpec);
  }
  if (config.domain) {
    const ensureDns = input.ensureDns ?? ((domain: string) => ensureZoneARecord(client, resolvedZone!, domain, rep.log));
    await ensureDns(config.domain);
  }
  const baseUrl = await resolveBaseUrl(
    input,
    config.domain ?? '',
    client,
    accountId,
    provisioned.coreName,
    rep,
  );

  // ④ 模块构建/上传/路由绑定
  rep.step(4, '构建上传模块 Worker，绑 <domain>/m/<id>/* 路由（zone 路径）与存储绑定');
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
    const isChat = mod.id === CHAT_MODULE_ID;
    const chatAssetsDir = isChat
      ? await (input.buildChatFrontend ?? buildChatFrontendAssets)({
          rootDir,
          outDir: provisioned.outDir,
          log: rep.log,
        })
      : undefined;
    // chat 包配置（DO 绑定 + 首部署 DO migrations 元数据）；readChatPackageConfig 已在步骤①通过形状检查
    const chatPkgMeta = isChat && chatPkg ? chatPkg : null;
    // 数据落点（#248）：shared 走 modules 库绑定；dedicated 额外绑专属库；core/external 仅 MODULES_DB
    const modLevel = storageLevelFor({ manifest: mod.manifest, id: mod.id });
    await writeConfig(
      join(provisioned.outDir, `modules/${mod.id}.wrangler.jsonc`),
      isChat && chatResources && chatPkg
        ? chatWranglerConfig({
            config,
            dbIds: { modules: dbIds.modules, chat: chatResources.dbId },
            kvId: chatResources.kvId,
            jwksJson,
            zoneName: resolvedZone?.name,
            pkg: chatPkg,
            assetsDir: chatAssetsDir!,
          })
        : moduleWranglerConfig({
            config,
            dbIds: { modules: dbIds.modules },
            mod,
            jwksJson,
            zoneName: resolvedZone?.name,
            storageLevel: modLevel,
            ...(modLevel === 'dedicated' ? { dedicatedDbId: dedicatedDbIds.get(mod.id) } : {}),
          }),
    );
    await writeConfig(
      join(provisioned.outDir, `modules/${mod.id}/worker.js`),
      prefixStripWrapperSource(mod.id),
    );
    // 模块上传：wrapper(main) + app.js(bundle) + SDK 资产目录
    const moduleDir = join(provisioned.outDir, 'modules', mod.id);
    const moduleBindings: Array<Record<string, unknown>> = [
      { type: 'd1', name: 'MODULES_DB', id: dbIds.modules },
      { type: 'assets', name: 'ASSETS' },
      { type: 'plain_text', name: 'MODULE_ID', text: mod.id },
      { type: 'plain_text', name: 'CORE_JWKS_JSON', text: jwksJson },
    ];
    if (modLevel === 'dedicated' && dedicatedDbIds.has(mod.id)) {
      // dedicated 专属库绑定（#248）：unself-<id>，绑定名 <ID>_DB（chat 的 DB 绑定走包配置同名兼容）
      moduleBindings.push({
        type: 'd1',
        name: `${mod.id.toUpperCase().replaceAll('-', '_')}_DB`,
        id: dedicatedDbIds.get(mod.id),
      });
    }
    // STORAGE_LEVEL 入 vars（由 moduleWranglerConfig 生成，模块 SDK 据此选通道）
    if (chatPkgMeta && chatResources) {
      // chat 专属绑定（#219 决策 #50 豁免）：专属 D1 + SESSIONS KV + FILES R2 + DO 三绑定
      moduleBindings.push(
        { type: 'd1', name: chatPkgMeta.d1Binding, id: chatResources.dbId },
        { type: 'kv_namespace', name: 'SESSIONS', namespace_id: chatResources.kvId },
        { type: 'r2_bucket', name: 'FILES', bucket_name: CHAT_R2_NAME },
        ...chatPkgMeta.doBindings.map((b) => ({ type: 'durable_object_namespace', ...b })),
      );
    }
    const moduleAssetsDir = isChat
      ? join(provisioned.outDir, 'modules', chatAssetsDir!)
      : join(provisioned.outDir, mod.assetsDir ?? join('modules', mod.id, 'assets'));
    // 首部署检测：脚本不存在 → 带 DO migrations 元数据建 SQLite 类；已部署 → 不带（幂等重传）
    const isFirstDeploy = await isWorkerNew(client, accountId, `unself-module-${mod.id}`);
    const chatMigrations = chatPkgMeta?.migrations?.[0];
    const doMigrations =
      isFirstDeploy && chatMigrations
        ? {
            newTag: chatMigrations.tag,
            steps: chatMigrations.new_sqlite_classes.map((cls) => ({ new_sqlite_classes: [cls] })),
          }
        : undefined;
    const moduleUpload = async (): Promise<void> =>
      uploadWorkerSpec(input, client, accountId, rep, {
        name: `unself-module-${mod.id}`,
        mainModule: 'worker.js',
        modules: [
          { name: 'worker.js', content: await readFile(join(moduleDir, 'worker.js'), 'utf8') },
          { name: 'app.js', content: await readFile(join(moduleDir, 'app.js'), 'utf8') },
        ],
        bindings: moduleBindings,
        compatibilityDate: '2026-09-01',
        compatibilityFlags: ['nodejs_compat'],
        observability: true,
        assets: {
          dir: moduleAssetsDir,
          binding: 'ASSETS',
          notFoundHandling: 'none',
          runWorkerFirst: true,
        },
        ...(doMigrations ? { migrations: doMigrations } : {}),
      });
    await moduleUpload();
    rep.log(`模块 ${mod.id} 已上传`);
    if (config.domain && resolvedZone) {
      await ensureRoute(client, resolvedZone.id, `${config.domain}/m/${mod.id}/*`, `unself-module-${mod.id}`, rep.log);
    }
    rep.log(`模块 ${mod.id} 路由就绪（/m/${mod.id}/*${isChat ? '，含前端产物 assets' : ''}）`);
    if (isChat) {
      const hasKeyring = await hasWorkerSecret(client, accountId, `unself-module-${mod.id}`, CHAT_KEYRING_SECRET);
      if (!hasKeyring) {
        const keyring = generateChatKeyring();
        if (input.putSecret) {
          await input.putSecret(`unself-module-${mod.id}`, keyring, CHAT_KEYRING_SECRET);
          rep.log(`写入 secret ${CHAT_KEYRING_SECRET}（测试注入口）`);
        } else {
          await putWorkerSecret(client, accountId, `unself-module-${mod.id}`, CHAT_KEYRING_SECRET, keyring);
        }
        // secret 生效需重部署（重传同产物；不带 DO migrations——已建类）
        await moduleUpload();
        chatKeyringAction = 'created';
      } else {
        rep.log(`${CHAT_KEYRING_SECRET} 已配置：沿用现有加密密钥环`);
        chatKeyringAction = 'existing';
      }
    }
  }

  // ④′ 未选模块（config.modules 未列出但已存在）：删除其 zone 路由 /m/<id>/*。
  const unselected = modules.filter((m) => !m.selected);
  if (unselected.length > 0) {
    const unselectedIds = unselected.map((m) => m.id);
    if (!config.domain || !resolvedZone) {
      rep.log(`跳过未选模块路由删除（未配置 domain，无 zone 路由）：${unselectedIds.join('、')}`);
    } else {
      const cleanupRoutes = input.cleanupModuleRoutes ?? (async (info) => {
        await removeRoutesForPatterns(
          client,
          info.zoneId,
          info.moduleIds.map((id) => `${info.domain}/m/${id}/*`),
          info.log,
        );
      });
      await cleanupRoutes({
        zoneId: resolvedZone.id,
        domain: config.domain,
        moduleIds: unselectedIds,
        log: rep.log,
      });
    }
  }

  // ⑤ registry 写入（ControlPlane：与 core-api/SQLite 同一份 SQL，#64）
  rep.step(5, '注册表写入（选中 enabled，未选 not_deployed）');
  const manifestTexts: Record<string, string> = {};
  for (const mod of modules) {
    if (mod.resolved) {
      // sourced：解析产物里已有 manifest 原文（yaml/json 双形态均可，#243 单轨解析）
      manifestTexts[mod.id] = mod.resolved.manifestText;
    } else {
      manifestTexts[mod.id] = await readFile(join(mod.dir, 'manifest.yaml'), 'utf8');
    }
  }
  for (const mod of modules) {
    if (!mod.selected) continue;
    const manifest = buildManifestSnapshot({
      manifestText: manifestTexts[mod.id] ?? '',
      moduleId: mod.id,
      baseUrl,
      ...(mod.resolved ? { manifest: mod.resolved.manifest } : {}),
    });
    // 存储选择（#55）写进快照：declaration 由 config 条目覆写（向导③½ / CLI），注册表快照即
    // 「这台实例上该模块数据在哪」的权威记录（core-api 门禁与运行时可读）。
    const entry = entries.find((e) => e.id === mod.id);
    const declaration = entry?.storage?.declaration;
    const snapshot = declaration
      ? { ...manifest, storage: { ...(manifest.storage ?? { accepts: [declaration] }), declaration } }
      : manifest;
    await coreCp.upsertModule({ id: mod.id, enabled: true, manifest: snapshot });
    rep.log(`upsert ${mod.id}（enabled=1，快照刷新${declaration ? `，落点 ${declaration}` : ''}）`);
  }
  for (const mod of unselected) {
    await coreCp.toggleModule(mod.id, false);
    rep.log(`disable ${mod.id}（not_deployed）`);
  }

  // ⑥ R2 / S3
  rep.step(6, '建 R2 桶或接收外部 S3 参数');
  if (config.storage.provider === 'r2') {
    await ensureR2Bucket(client, accountId, config.storage.bucket, rep.log);
  } else {
    rep.log(`外部 S3：endpoint=${config.storage.endpoint} bucket=${config.storage.bucket}（不建桶）`);
  }

  // ⑦ OIDC（无操作）
  rep.step(7, 'OIDC 配置（不在脚本/配置文件中——部署后在 setup 向导填写）');
  rep.log('跳过：OIDC 凭证由部署者在 setup 向导录入，存 core 库（§5.5 已知缺口见 spec）');

  // ⑧ setup token（#165 方案 B：本地生成 + ControlPlane 写入 core 库）
  rep.step(8, '本地生成一次性 setup token 并写入 core 库');
  const setup = await coreCp.issueSetupToken(generateSetupToken);
  if (setup.status === 'sealed') {
    rep.log('setup 已完成（实例已封死激活入口）——跳过 token 签发');
  } else {
    if (setup.status === 'reused') rep.log('复用未消费的一次性 setup token（重跑幂等）');
    else rep.log('一次性 setup token 已写入 core 库');
    rep.log(`一次性激活链接：${baseUrl}/setup?token=${setup.token}`);
  }

  // ⑧½ lock 落盘（#245）：装配全程无哈希失败、无中途异常才会走到这里——写锁即「本次安装已兑现」。
  // 测试注入 preLock 时跳过真实写盘（测试断言面单独读 lock 文件时用真实写）。
  if (input.preLock === undefined) {
    const newLock: LockFile = {
      lockVersion: 1,
      generatedAt: new Date().toISOString(),
      modules: lockModules,
    };
    await writeConfig(join(rootDir, LOCK_FILENAME), serializeLock(newLock));
    rep.log(`unself.lock 已更新（${Object.keys(lockModules).length} 个模块）`);
  }

  // ⑨ 冒烟 + 主题体检（§6.5.8 验产物）
  rep.step(9, '冒烟检查 /api/health 与各模块 health + 主题体检');
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

  const themeChecks = input.http
    ? input.http.themeCheck
      ? await input.http.themeCheck(baseUrl, selected.map((m) => m.id))
      : []
    : await checkModuleThemes({
        baseUrl,
        moduleIds: selected.map((m) => m.id),
      });
  for (const r of themeChecks) {
    const mark = r.ok ? (r.skinned ? 'ⓘ（独立皮肤）' : '✓') : '✗';
    const unknownPart = r.unknown.length > 0 ? `（未知令牌：${r.unknown.join('、')}）` : '';
    const detailPart = r.detail ? `（${r.detail}）` : '';
    rep.log(`${mark} 主题 ${r.name} → ${r.url}${unknownPart}${detailPart}`);
  }
  const themeFailed = themeChecks.filter((r) => !r.ok);
  if (themeFailed.length > 0) {
    throw new Error(
      `主题体检失败：${themeFailed
        .map((f) => `${f.name}(${f.url}): ${f.unknown.length > 0 ? `未知令牌 ${f.unknown.join('、')}` : (f.detail ?? '未知原因')}`)
        .join('；')}`,
    );
  }

  return {
    baseUrl,
    core: { name: provisioned.coreName, config: provisioned.coreConfig },
    modules: provisioned.modules.map((m) => ({ id: m.id, config: m.config })),
    d1: dbIds,
    r2Bucket: provisioned.r2Bucket,
    chat: chatMod
      ? {
          db: CHAT_DB_NAME,
          kv: CHAT_KV_NAME,
          r2: CHAT_R2_NAME,
          keyringAction: chatKeyringAction!,
        }
      : undefined,
    setup: setup.status === 'sealed' ? { sealed: true as const } : { setupUrl: `/setup?token=${setup.token}` },
    keypairAction: freshPair ? 'created' : 'existing',
    themeChecks,
  };
}

/** 默认 REST 客户端：env token → 借 wrangler OAuth（决策 #65/#66，#246 起 resolveAuth 统一收口）。 */
async function defaultClient(log: (m: string) => void): Promise<RestClient> {
  const cred = await resolveAuth({ log });
  if (!cred) {
    throw new CredentialsMissingError(credentialsMissingMessage());
  }
  if (cred.warning) log(`⚠ ${cred.warning}`);
  return new RestClient({ token: cred.token });
}

/** worker 上传（真实路径）：assets 直传 + putWorker。测试可注入 uploadWorker 替身。 */
async function uploadWorkerSpec(
  input: { uploadWorker?: (u: WorkerUploadSpec) => Promise<void> },
  client: RestClient,
  accountId: string,
  rep: StepReporter,
  spec: WorkerUploadSpec,
): Promise<void> {
  if (input.uploadWorker) {
    await input.uploadWorker(spec);
    return;
  }
  let assetsJwt: string | undefined;
  if (spec.assets) {
    const manifest = buildAssetManifest(spec.assets.dir);
    const session = await startAssetSession(client, accountId, spec.name, manifest);
    assetsJwt = await uploadMissingAssets(client, accountId, session, manifest, spec.assets.dir);
    rep.log(`assets 就绪（${Object.keys(manifest).length} 个文件）`);
  }
  await putWorker(client, accountId, {
    name: spec.name,
    mainModule: spec.mainModule,
    modules: spec.modules,
    compatibilityDate: spec.compatibilityDate,
    compatibilityFlags: spec.compatibilityFlags,
    bindings: spec.bindings as WorkerBinding[] | undefined,
    observability: spec.observability,
    migrations: spec.migrations,
    ...(assetsJwt
      ? {
          assets: {
            jwt: assetsJwt,
            config: {
              html_handling: spec.assets!.htmlHandling ?? 'auto-trailing-slash',
              not_found_handling: spec.assets!.notFoundHandling,
              run_worker_first: spec.assets!.runWorkerFirst,
            },
          },
        }
      : {}),
  });
}

/** baseUrl 决策：config.domain 优先；否则查 workers.dev 子域（REST）。导出仅为直测（#193 T3）。 */
export async function resolveBaseUrl(
  input: { resolveBaseUrl?: (domain: string, workerName: string) => Promise<string>; http?: unknown },
  domain: string,
  client: RestClient,
  accountId: string,
  coreName: string,
  rep: StepReporter,
): Promise<string> {
  if (input.resolveBaseUrl) {
    return input.resolveBaseUrl(domain, coreName);
  }
  if (domain) {
    return `https://${domain}`;
  }
  rep.log('未配置 domain：以 workers.dev 域名对外（unself.config.jsonc domain 留空）');
  const subdomain = await workersDevSubdomain(client, accountId);
  if (!subdomain) {
    throw new Error('无法解析 workers.dev 子域；请在 unself.config.jsonc 配置 domain');
  }
  await enableWorkersDev(client, accountId, coreName);
  // workers.dev 子域 API 只回子域名（无后缀）——完整域名需拼 .workers.dev
  return `https://${coreName}.${subdomain}.workers.dev`;
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

/**
 * core Worker 入口：core-api 优先；未命中（HTML 导航）回退 ASSETS 的 SPA。相对路径按生成文件目录（.deploy/cloudflare/）计。
 *
 * 组合根（#141 返工）：deploy 是唯一生产装配点——生成入口 import { createApp } 并注入真 Stalwart 适配器，
 * core-api 自身不再模块级固化无参实例（那会把 members.ts 的契约回退假实现带进生产开户路径）。
 * 适配器用相对路径导入：生成目录没有 workspace 的 node_modules 链接，裸包名解析不到；
 * 相对路径与 core-api 的导入同构，esbuild 打包确定可解析。
 */
export function coreWorkerEntrySource(outDir: string, rootDir: string): string {
  const rel = (p: string): string => relative(outDir, join(rootDir, p)).replaceAll('\\', '/');
  return `// SPDX-License-Identifier: AGPL-3.0-only
// 由 deploy/cloudflare 生成（生产组合根）：core-api app（注入 Stalwart 适配器）+ 未命中路径回退 SPA 资产。
import { createApp } from '${rel('services/core-api/src/index.ts')}';
import { createStalwartMailProvisioner } from '${rel('adapters/provisioning/stalwart/src/index.ts')}';
import { withHtmlSecurityHeaders } from '${rel('services/core-api/src/security-headers.ts')}';

const app = createApp({ createMailProvisioner: (cfg) => createStalwartMailProvisioner(cfg) });

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
    // 决策 #47：/<domain>/setup* 走 Worker（run_worker_first），其 HTML 不经静态资产
    // 的 _headers，故在这里补同一套安全头（值同源：security-headers.ts）。
    return withHtmlSecurityHeaders(await env.ASSETS.fetch(new URL('/', url.origin).toString(), request));
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
  /** chat 专属供给摘要（未选 chat 时 undefined；#219）。 */
  chat?: {
    db: string;
    kv: string;
    r2: string;
    /** 密钥环 Secret 动作：首部署生成注入 / 沿用既有（幂等）。 */
    keyringAction: 'created' | 'existing';
  };
  /** 部署期主题体检结果（§6.5.8）；测试注入无 themeCheck 时为 []。 */
  themeChecks: ThemeCheckResult[];
}

export { CORE_DB_NAME, MODULES_DB_NAME, DEPLOY_DIR, CHAT_DB_NAME, CHAT_KV_NAME, CHAT_R2_NAME };
