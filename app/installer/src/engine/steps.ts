// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 幂等九步编排（PRODUCT_SPEC §5.5，#14；#244 REST 化）：
 * ① 两 D1（chat 选中时含专属 D1/KV/R2）→ ② 迁移（REST import + 按模块独立记账）
 * → ③ Shell Worker → ④ 模块构建/上传/路由绑定（assets 直传 + secret；未选模块路由删除）
 * → ⑤ registry（ControlPlane）→ ⑥ R2 → ⑦ OIDC（无操作）→ ⑧ 本地签发 setup token（ControlPlane）
 * → ⑨ 冒烟 + 主题体检。
 * 所有资源查漏后补建：连跑两次收敛（#14 验收）。全程不安装、不调用 wrangler（决策 #65）。
 */
import { cp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { probeSqlite } from '@unself/control-plane';
import {
  DEPLOY_DIR,
  coreRunWorkerFirst,
  coreWranglerConfig,
  moduleWranglerConfig,
  prefixStripWrapperSource,
  provisionAll,
  writeConfig,
  type Provisioned,
} from './assemble';
import { loadUnselfConfig, moduleIds, normalizeModuleEntries, type ModuleRef, type NormalizedModuleEntry, type UnselfConfig } from './config';
import type { ModuleManifest } from '@unself/contracts';
import { LOCK_FILENAME, emptyLock, parseLockText, serializeLock, type LockFile, type ResourceLedger } from './lock';
import { lockRecordFrom, resolveSources } from './module-sources';
import { resolvePlatformArtifacts } from './artifacts';
import { moduleWorkerName, coreWorkerName, coreDbName, modulesDbName, resourceName, resourcePrefix, setResourceNamespace, activeResourceNamespace } from './naming';
import { decideGuard, probeExisting, targetResources } from './guard';
import { createCoreControlPlane } from './control-plane';
import { CredentialsMissingError, credentialsMissingMessage, resolveAuth } from './auth';
import type { TokenSourceKind } from './auth';
import { domainProblem } from './domain';
import { createKeypair, JWT_SECRET_NAME, publicJwksJson } from './keypair';
import { ensureRoute, ensureTotalTls, ensureZoneARecord, findZone, removeLegacyCustomDomains, removeRoutesForPatterns } from './rest/zones';
import { ensureDatabases, validateS3Storage } from './provision';
import { ensureD1 } from './rest';
import {
  RestClient,
  findAccountId,
  putWorker,
  hasWorkerSecret,
  putWorkerSecret,
  enableWorkersDev,
  ensureR2Bucket,
  workersDevSubdomain,
} from './rest';
import { buildAssetManifest, startAssetSession, uploadMissingAssets } from './rest/assets';
import type { WorkerBinding } from './rest/workers';
import {
  CHAT_KEYRING_SECRET,
  CHAT_MODULE_ID,
  chatDbName,
  chatKvName,
  chatR2Name,
  chatWranglerConfig,
  ensureChatResources,
  ensureChatR2Bucket,
  generateChatKeyring,
  readChatPackageConfig,
} from './chat-provision';
import {
  checkSharedGuards,
  dedicatedDbNameFor,
  doMigrationLedgerName,
  migrationDirFor,
  migrationFailure,
  planDoMigrations,
  readSqlFiles,
  storageLevelFor,
  type StorageLevel,
} from './migrate';
import { buildChatFrontendAssets } from './chat-frontend';
import { buildManifestSnapshot } from './registry';
import { checkModuleThemes, smokeCheck } from './smoke';
import type { ModuleTarget, ThemeCheckResult } from './smoke';
import { generateSetupToken } from './smoke';
import {
  moduleBaseUrl,
  moduleEntryUrl,
  moduleRoutePattern,
  mountShapeOf,
  originOf,
  parseWorkersDevSubdomain,
} from './module-url';

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
 * 模块发现（#77 A 方案：不再扫目录）：config `modules` 条目就是全部模块——官方模块也写
 * `npm:@unself/hello@0.1.0`，与第三方同一个解析器（包根在来源解析后回填 dir/resolved）。
 * 未在 config 里的已部署模块（lock 有记录）由 `resolveSources` 的 removed 名单交给
 * 路由清理与注册表 disable（不再依赖「扫描出没选中的 builtin 模块」）。
 */
export async function discoverModules(
  _rootDir: string,
  _selectedIds: string[],
  entries?: NormalizedModuleEntry[],
): Promise<ModuleRef[]> {
  return (entries ?? []).map((e) => ({ id: e.id, dir: '', selected: true, source: e.source }));
}

/**
 * 模块存储落点（#248）：只认 config 条目的 storage.declaration（用户选定）→ 无则按 manifest 声明。
 * 解析前 mod.dir 为空 → 按 core 处理；来源解析后（步骤②½）按 resolved.manifest 重算。
 * 结果缓存：步骤②（迁移）与步骤④（绑定/生成配置）必须用同一个落点，避免两处各读一次走偏。
 */
interface StoragePlan {
  level: StorageLevel;
  /** 模块 manifest（#284 起必来自来源解析产物）；shared 护栏②的 tables 从这里取。 */
  manifest?: ModuleManifest;
}

/** 从解析产物推落点（无 resolved → core：解析前调用方用，解析后一律有 resolved）。 */
function storagePlanOf(mod: ModuleRef): StoragePlan {
  if (!mod.resolved) return { level: 'core' };
  return {
    level: storageLevelFor({ manifest: mod.resolved.manifest, id: mod.id }),
    manifest: mod.resolved.manifest,
  };
}

function storagePlansFor(modules: ModuleRef[]): Map<string, StoragePlan> {
  const out = new Map<string, StoragePlan>();
  for (const mod of modules) out.set(mod.id, storagePlanOf(mod));
  return out;
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

/** 九步主流程选项。 */
export interface RunNineStepsOptions {
  rootDir: string;
  /** REST 客户端（测试注入替身；缺省由凭证解析新建）。 */
  client?: RestClient;
  /**
   * 凭证来源（#309 ④）：`client` 注入时缺省按 `env-api-token`（幂等行为不变）；
   * 缺省凭证解析路径自动携带真实来源。`wrangler-oauth` 时 DNS 自建跳过（#241 实测
   * OAuth scope 集合不含 dns_records 读写），给人话指引而非让部署必然撞 10000。
   */
  credentialSource?: 'env-api-token' | 'env-api-key' | 'wrangler-oauth';
  reporter?: StepReporter;
  /**
   * @internal 仅供测试注入（steps.test.ts）：跳过真实 HTTP（冒烟/主题体检）。
   * 签名与真实实现同形：core URL + 按形态算好的模块 target 列表（#273——
   * 注入方拿到的就是生产要探的 URL，不另拼一套）。
   * 生产路径一律走 smoke.ts 的真实实现；smokeCheck/checkModuleThemes 由 smoke.test.ts 直测。
   */
  http?: {
    smoke(coreUrl: string, modules: ModuleTarget[]): Promise<Array<{ name: string; url: string; ok: boolean; status: number; detail?: string }>>;
    /** 可选：主题体检注入（§6.5.8）。缺省 = 跳过（保持既有测试语义，不请求网络）。 */
    themeCheck?: (coreUrl: string, modules: ModuleTarget[]) => Promise<ThemeCheckResult[]>;
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
  /**
   * 显式指定 `@unself/workbench` 包目录（测试 / 嵌入式）。缺省 = 从 node_modules 解析该包
   * （安装器依赖它）——**仓库形态与安装形态同源**，没有第二套行为。显式给的值必须合法。
   */
  workbenchDir?: string;
  /**
   * 撞车守卫放行开关（#272）：账户里已有同名资源且台账证明不了归属时，默认停住；
   * 显式 `--allow-adopt` / `UNSELF_ALLOW_ADOPT=1` / 向导④「允许接管」才继续。
   * 缺省 = 读 `UNSELF_ALLOW_ADOPT`（`=1` 视为 true）。
   */
  allowAdopt?: boolean;
}

/**
 * 九步主流程（#272）：进入时把 `config.namespace` 登记为资源命名空间，退出还原——
 * 命名空间状态只活在本次运行内（不会污染同进程的下一实例/探针）。
 */
export async function runNineSteps(input: RunNineStepsOptions): Promise<Summary> {
  const config = input.configOverride ?? (await loadUnselfConfig(input.rootDir));
  const prevNamespace = activeResourceNamespace();
  setResourceNamespace(config.namespace);
  try {
    return await runNineStepsInner({ ...input, configOverride: config });
  } finally {
    setResourceNamespace(prevNamespace);
  }
}

/** 九步主流程实现（命名空间已由 wrapper 登记）。返回部署摘要（供测试断言与部署输出）。 */
async function runNineStepsInner(input: RunNineStepsOptions): Promise<Summary> {
  const { rootDir } = input;
  const rep = input.reporter ?? consoleReporter();
  // 平台产物解析（#303 修订 #257 口径）：产物随 @unself/workbench 包发布，引擎只当消费者。
  // 解析不出 / 没构建 → 当场抛人话错（不静默回落，不回读源码树）。
  const platform = resolvePlatformArtifacts({ rootDir, workbenchDir: input.workbenchDir });
  rep.log(`平台产物：${platform.root}（@unself/workbench@${platform.version}）`);
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

  // unself.lock 提前读取（#272）：撞车守卫要用它的资源台账判定「同名资源是否属于本实例」；
  // 来源解析（②½）也要用它做 reuse/drift 决策。
  const lockPath = join(rootDir, LOCK_FILENAME);
  let lock: LockFile = emptyLock();
  if (input.preLock !== undefined) {
    lock = parseLockText(input.preLock);
  } else if (existsSync(lockPath)) {
    lock = parseLockText(await readFile(lockPath, 'utf8'));
  }

  const resolved = input.client
    ? { client: input.client, source: input.credentialSource ?? ('env-api-token' as const) }
    : await defaultClient(rep.log);
  const client = resolved.client;
  const credentialSource = resolved.source;

  // ②½ 来源解析（#245/#284）——**必须在步骤①之前**：
  // ① 要读 chat 包配置（dir）与各模块存储落点（dedicated 目标名），那些都得先取到包。
  // 全部模块都走这条路（#77：官方模块也是 npm 包，npm: 本地命中则零网络）；
  // 漂移未确认/哈希不匹配在此直接报错，不产生任何 CF 资源（fail before side effect）。
  // outDir 由 provisionAll 在步骤③建——本步先手动建（module-sources 暂存区要落盘）。
  const outDirPre = join(rootDir, DEPLOY_DIR);
  const { mkdir: mkdirPre } = await import('node:fs/promises');
  await mkdirPre(outDirPre, { recursive: true });
  const resolution = await resolveSources({
    rootDir,
    outDir: outDirPre,
    entries,
    lock,
    confirmed: input.yes,
    log: rep.log,
    ...(input.fetchers ? { fetchers: input.fetchers as Parameters<typeof resolveSources>[0]['fetchers'] } : {}),
  });
  for (const mod of resolution.sourced) {
    const ref = modules.find((m) => m.id === mod.id);
    if (!ref) throw new Error(`来源解析返回了 config 未声明的模块 ${mod.id}（引擎内部不一致）`);
    ref.dir = mod.packageDir;
    ref.resolved = mod;
  }
  /**
   * 未选模块（config 已删除但 lock 里还记着的）——步骤④′撤 zone 路由 + 步骤⑤注册表 disable。
   * 不再靠「扫目录扫出未选中的 builtin 模块」（#284：目录扫描已删）；lock 是实例已装模块的权威记录。
   */
  const removedIds = resolution.removed;
  // 数据落点（#248 四级）：声明来自来源解析产物（manifest），用户选择覆写 config 条目的 storage.declaration。
  const storagePlans = storagePlansFor(selected);
  // lock 记录（决策 #60）：只有本次 config 声明的模块进 lock（removed 的旧记录随 removedIds 移除）。
  const lockModules: LockFile['modules'] = {};
  for (const mod of selected) {
    if (!mod.resolved) throw new Error(`模块 ${mod.id} 未完成来源解析（引擎内部不一致）`);
    lockModules[mod.id] = lockRecordFrom(mod.resolved);
  }

  // ① D1（chat 选中时：包配置先过一道形状检查，再补建专属 D1/KV/R2）
  rep.step(1, '确保 core/modules 两个 D1 存在（chat 选中时含专属 D1/KV/R2）');
  const accountId = await findAccountId(client);
  if (!accountId) throw new Error('无法解析 CF 账户（GET /accounts 失败或为空）——检查凭证');

  // ①′ 撞车守卫（#272，硬）：账户里已有同名资源且不属于本实例 → 停住（不创建/不修改），
  // 要显式开关才继续。仅在「隔离模式」（有命名空间或显式前缀）下比较目标名；
  // 历史无前缀实例的命名就是 unself-*（#272 之前的生产实例零影响，幂等重跑语义不变）。
  if (resourcePrefix() !== '') {
    const targets = targetResources({
      prefix: resourcePrefix(),
      moduleIds: selected.map((m) => m.id),
      ...(config.storage.provider === 'r2' ? { bucket: config.storage.bucket } : {}),
      dedicatedModuleIds: selected
        .filter((m) => storagePlans.get(m.id)?.level === 'dedicated')
        .map((m) => m.id),
      chatSelected: selected.some((m) => m.id === CHAT_MODULE_ID),
    });
    const existing = await probeExisting(client, accountId, targets);
    const outcome = decideGuard({
      existing,
      ledger: lock.resources,
      allowAdopt: input.allowAdopt ?? process.env.UNSELF_ALLOW_ADOPT === '1',
    });
    if (outcome.status === 'owned') {
      rep.log(`撞车守卫：${existing.length} 个同名资源与本实例台账一致（幂等重跑），放行`);
    } else if (outcome.status === 'adopted') {
      rep.log(
        `撞车守卫：显式接管 ${outcome.foreign.length} 个既有资源（--allow-adopt）：${outcome.foreign
          .map((f) => f.name)
          .join('、')}`,
      );
    }
  }

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
  const coreMigrationDir = platform.coreMigrationsDir;
  await coreCp.applyMigrations('core', await readSqlFiles(coreMigrationDir));
  rep.log(`core 迁移已应用（${coreDbName()}，记账 unself_migrations_core）`);
  /** dedicated 模块的独立 D1 id（步骤①补建；摘要与绑定共用）。 */
  const dedicatedDbIds = new Map<string, string>();
  /**
   * 模块记账表所在 D1（#255）：与步骤②里模块迁移落点**同一个库**——DO 迁移 tag 的
   * 「已应用」判定与写入都挂在这张 `unself_migrations_<模块>` 上，不另造第二套记账。
   */
  const moduleLedgerDbIds = new Map<string, string>();
  // 平台基建（#248）：core 级模块经 Core API 代理存取，代理的承载表 module_kv 归 core
  // （docs/modules.md §4「core 的 schema 归 core」）——与模块无关，必须在任何 core 级模块跑之前就位。
  // 记账独立（unself_migrations_platform，落在 modules 库）：与各模块记账互不覆盖（#55 护栏①同规）。
  const modulesCp = createCoreControlPlane(client, accountId, dbIds.modules);
  const platformMigrationDir = platform.platformMigrationsDir;
  const platformFiles = await readSqlFiles(platformMigrationDir);
  if (platformFiles.length > 0) {
    try {
      const report = await modulesCp.applyMigrations('platform', platformFiles);
      rep.log(`平台迁移（modules 库）：应用 ${report.applied.length} 个${report.skipped.length > 0 ? `，记账跳过 ${report.skipped.length} 个` : ''}`);
    } catch (err) {
      const applied = await modulesCp.appliedMigrations('platform');
      const pending = platformFiles.filter((f) => !applied.includes(f.name));
      for (const file of pending) {
        try {
          await modulesCp.applyMigrations('platform', [file]);
        } catch (fileErr) {
          throw migrationFailure({ moduleId: 'platform', file: file.name, sql: file.sql, cause: fileErr });
        }
      }
      throw migrationFailure({
        moduleId: 'platform',
        file: pending[pending.length - 1]?.name ?? '(未知)',
        sql: pending[pending.length - 1]?.sql ?? '',
        cause: err,
      });
    }
  }
  /**
   * 单个模块的落点迁移（#248）：core/external 无事；shared 走三护栏 + 共享库；dedicated 走专属库。
   * 抽成闭包是为了 sourced 模块能在**来源解析之后**补跑一趟（解析前 mod.dir 还空，读不到 manifest 与 migrations/）。
   */
  const applyModuleStorage = async (mod: ModuleRef): Promise<void> => {
    const plan = storagePlans.get(mod.id) ?? storagePlanOf(mod);
    const level: StorageLevel = plan?.level ?? 'core';
    if (mod.id === CHAT_MODULE_ID && chatResources) {
      // chat（#74/#248 普通化）：专属库在步骤①建（`unself-chat`），这里把 id 记进落点表——
      // 之后与任何 dedicated 模块走**同一条**通用迁移链（migrations/chat/0001_baseline.sql +
      // 独立记账 unself_migrations_chat），不再有「一次性灌 schema」的存储豁免。
      // （chat 的 KV/R2/DO 绑定是模块资源，由包配置提供，见步骤④——与存储落点无关。）
      dedicatedDbIds.set(mod.id, chatResources.dbId);
    }
    if (level === 'core') {
      rep.log(`模块 ${mod.id} 落点 core：数据经 Core API 代理，无模块建表`);
      return;
    }
    if (level === 'external') {
      rep.log(`模块 ${mod.id} 落点 external：自备外部库，装配器不接线（连接串走配置页）`);
      return;
    }
    const migDir = migrationDirFor(mod.dir, mod.id);
    const files = await readSqlFiles(migDir);
    if (files.length === 0) {
      throw new Error(
        `模块 ${mod.id} 落点 ${level}（自建表）但包内没有 migrations/${mod.id}/ 迁移文件——装一半的库没人受益，先补迁移再装`,
      );
    }
    const manifest = plan?.manifest;
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
    // 记账库登记（步骤④的 DO 迁移判定/写入必须用同一个库同一张表）
    moduleLedgerDbIds.set(mod.id, targetDbId);
    const targetCp = createCoreControlPlane(client, accountId, targetDbId);
    // 逐文件带定位地跑：applyMigrations 内部按记账跳过；失败转「模块/文件/第几条语句」人话。
    try {
      const report = await targetCp.applyMigrations(mod.id, files);
      rep.log(
        `模块 ${mod.id} 迁移：本次应用 ${report.applied.length} 个${report.skipped.length > 0 ? `，记账跳过 ${report.skipped.length} 个` : ''}`,
      );
    } catch (err) {
      // 逐文件重放定位：找到第一份「记账上未应用」的文件再跑一次，捕原始错误转三要素
      const applied = await targetCp.appliedMigrations(mod.id);
      const pending = files.filter((f) => !applied.includes(f.name));
      for (const file of pending) {
        try {
          await targetCp.applyMigrations(mod.id, [file]);
        } catch (fileErr) {
          throw migrationFailure({ moduleId: mod.id, file: file.name, sql: file.sql, cause: fileErr });
        }
      }
      // 逐文件重放全部成功（竞态/瞬时差异）→ 保留原始错误上下文人话化
      throw migrationFailure({ moduleId: mod.id, file: pending[pending.length - 1]?.name ?? '(未知)', sql: pending[pending.length - 1]?.sql ?? '', cause: err });
    }
  };
  for (const mod of selected) {
    if (mod.dir) await applyModuleStorage(mod);
  }
  // node:sqlite 探测（Docker 落点可用性预检；不可用给人话不崩——仅提示，不阻断 CF 部署）
  const sqlite = probeSqlite();
  rep.log(sqlite.usable ? `node:sqlite 可用（${sqlite.version}）：Docker 模块落点就绪` : `node:sqlite 不可用：${sqlite.reason.split('\n')[0]}（Docker 落点暂不可用，CF 部署不受影响）`);

  // ③ Shell Worker（构建 + 上传）
  rep.step(3, '构建上传 Shell Worker（壳 + Core API）');
  const provisionInput = {
    rootDir,
    config,
    modules,
    dbIds,
      platform,
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
  // core Worker bundle 由 @unself/workbench 自己构建（生产组合根 + esbuild 都在包内，#303）：
  // 引擎只搬不建——干净机器不需要 esbuild，引擎也不需要知道 workbench 内部文件长什么样。
  await cp(platform.coreWorker, join(provisioned.outDir, 'core-worker.js'));
  // core 上传描述（secret 首部署后补写 → 同描述重传一次；幂等收敛）
  const coreVars: Record<string, string> = {};
  if (config.domain) coreVars.UNSELF_BASE_URL = `https://${config.domain}`;
  const coreMainModule = 'core-worker.js';
  const coreSpec: WorkerUploadSpec = {
    name: provisioned.coreName,
    mainModule: coreMainModule,
    modules: [{ name: coreMainModule, content: await readFile(join(provisioned.outDir, coreMainModule), 'utf8') }],
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
      // #273：workers.dev 形态 true——壳 HTML 必须经 worker 才能带按注册表生成的 frame-src 白名单
      runWorkerFirst: coreRunWorkerFirst(config),
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
    // #309 ④：DNS 自建按凭证来源分流。wrangler OAuth 的 scope 集合不含 dns_records 读写
    // （2026-09-21 实测，wrangler 4.129.1，docs/audit/241-*），必挂 10000——跳过并给人话指引，
    // 部署不因此失败（资源/路由/产物全部就绪，仅 DNS 记录一个人工步骤；冒烟⑨会明报域名不通）。
    // ensureDns 显式注入（测试）时按注入走，不参与分流。
    if (input.ensureDns) {
      await input.ensureDns(config.domain);
    } else if (credentialSource === 'wrangler-oauth') {
      rep.log(
        `跳过 DNS 自建（wrangler OAuth 无 dns_records 权限，#241 实测）：请在 CF 控制台为 ${config.domain} ` +
          '手动添加 A 记录 192.0.2.1（开启代理），或改用 API Token（含 Zone · DNS · Edit）重跑自动创建',
      );
    } else {
      await ensureZoneARecord(client, resolvedZone!, config.domain, rep.log);
    }
  }
  const baseUrl = await resolveBaseUrl(
    input,
    config.domain ?? '',
    client,
    accountId,
    provisioned.coreName,
    rep,
  );

  // 模块真实可达 URL（#273 唯一真值源）：注册表 entry / wrapper frame-ancestors / ⑨冒烟 / 主题体检四处共用。
  // workers.dev 形态 = 模块自有子域（CF 为每个上传 Worker 免费提供，无需 DNS/zone 权限）；
  // domain 形态 = zone 路径 `https://<domain>/m/<id>`。子域直接复用 resolveBaseUrl 已查到的值，不二次请求。
  const shape = mountShapeOf(config.domain);
  const workersDevAccountSubdomain =
    shape === 'domain'
      ? null
      : (parseWorkersDevSubdomain(baseUrl, provisioned.coreName) ??
        (await workersDevSubdomain(client, accountId)));
  if (shape === 'workers-dev' && !workersDevAccountSubdomain) {
    throw new Error(
      'workers.dev 形态无法解析账号子域（GET /accounts/<id>/workers/subdomain 为空）：' +
        '模块真实 URL 拼不出来——检查凭证权限，或在 unself.config.jsonc 配置 domain',
    );
  }
  const moduleTargets: ModuleTarget[] = selected.map((m) => ({
    id: m.id,
    baseUrl: moduleBaseUrl({
      domain: config.domain ?? '',
      workersDevSubdomain: workersDevAccountSubdomain,
      moduleId: m.id,
      moduleWorkerName: moduleWorkerName(m.id),
    }),
  }));
  const moduleBaseUrlOf = (id: string): string =>
    moduleTargets.find((t) => t.id === id)?.baseUrl ??
    moduleBaseUrl({
      domain: config.domain ?? '',
      workersDevSubdomain: workersDevAccountSubdomain,
      moduleId: id,
      moduleWorkerName: moduleWorkerName(id),
    });

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
    // chat 前端资产（#284）：包内 `assets/frontend/**` 就是预构建产物（发布形态）；
    // 源码形态（仓库 workspace 符号链接 / file:）走 vite 重建（#73：不吞旧产物）。
    const chatPrebuiltDir = isChat && mod.dir && existsSync(join(mod.dir, 'assets', 'frontend'))
      ? join(mod.dir, 'assets', 'frontend')
      : undefined;
    const chatAssetsDir = isChat
      ? await (input.buildChatFrontend ??
          ((i: { rootDir: string; outDir: string; log: (msg: string) => void }) =>
            buildChatFrontendAssets({
              ...i,
              ...(existsSync(join(mod.dir, 'manifest.json')) && chatPrebuiltDir ? { prebuiltDir: chatPrebuiltDir } : {}),
            })))({
          rootDir,
          outDir: provisioned.outDir,
          log: rep.log,
        })
      : undefined;
    // chat 包配置（DO 绑定 + 首部署 DO migrations 元数据）；readChatPackageConfig 已在步骤①通过形状检查
    const chatPkgMeta = isChat && chatPkg ? chatPkg : null;
    // 数据落点（#248）：shared 走 modules 库绑定；dedicated 额外绑专属库；core/external 仅 MODULES_DB
    const modLevel: StorageLevel = storagePlans.get(mod.id)?.level ?? 'core';
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
      prefixStripWrapperSource(mod.id, {
        // domain：剥 /m/<id> 前缀；workers.dev：模块自有子域根挂载，无需剥
        mount: config.domain ? `/m/${mod.id}` : '',
        // 决策 #63/#73：模块页自带 frame-ancestors，值 = 壳 origin（跨子域 iframe 才不被裁）
        shellOrigin: originOf(baseUrl),
      }),
    );
    // 模块上传：wrapper(main) + app.js(bundle) + SDK 资产目录
    const moduleDir = join(provisioned.outDir, 'modules', mod.id);
    const moduleBindings: Array<Record<string, unknown>> = [
      { type: 'd1', name: 'MODULES_DB', id: dbIds.modules },
      { type: 'assets', name: 'ASSETS' },
      { type: 'plain_text', name: 'MODULE_ID', text: mod.id },
      { type: 'plain_text', name: 'CORE_JWKS_JSON', text: jwksJson },
    ];
    if (modLevel === 'core') {
      // core 级（#248 收敛（a)）：模块唯一数据通道 = Core API 代理；跨 worker 用 Service Binding
      // （同 zone 明文 fetch 被 CF 平台禁 → 只有绑定这条路能在生产成立）。
      moduleBindings.push({ type: 'service', name: 'CORE_API', service: coreWorkerName() });
    }
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
        { type: 'r2_bucket', name: 'FILES', bucket_name: chatR2Name() },
        ...chatPkgMeta.doBindings.map((b) => ({ type: 'durable_object_namespace', ...b })),
      );
    }
    const moduleAssetsDir = isChat
      ? join(provisioned.outDir, 'modules', chatAssetsDir!)
      : join(provisioned.outDir, mod.assetsDir ?? join('modules', mod.id, 'assets'));
    // DO 迁移判定（#255）：不再用 isWorkerNew（脚本存在与否 ≠ DO SQLite 类已建）。
    // 依据 = 模块记账表里的已应用 tag（#248 同一套记账）；上传成功后记账，失败不记。
    const declaredDoMigrations = chatPkgMeta?.migrations ?? [];
    let doMigrations: { oldTag?: string; newTag: string; steps: Array<Record<string, unknown>> } | undefined;
    let doMigrationCp: ReturnType<typeof createCoreControlPlane> | null = null;
    let pendingDoTags: string[] = [];
    if (declaredDoMigrations.length > 0) {
      const ledgerDbId = moduleLedgerDbIds.get(mod.id);
      if (!ledgerDbId) {
        throw new Error(
          `模块 ${mod.id} 声明了 DO 迁移（migrations）但落点 core/external（无模块记账库）：` +
            'DO 迁移的「已应用」判定必须有落脚账表，先声明 shared/dedicated 落点',
        );
      }
      doMigrationCp = createCoreControlPlane(client, accountId, ledgerDbId);
      const appliedNames = await doMigrationCp.appliedMigrations(mod.id);
      const plan = planDoMigrations({ declared: declaredDoMigrations, appliedNames });
      if (plan) {
        doMigrations = { ...(plan.oldTag !== undefined ? { oldTag: plan.oldTag } : {}), newTag: plan.newTag, steps: plan.steps };
        pendingDoTags = plan.tags;
        rep.log(`模块 ${mod.id} DO 迁移待应用（记账未记）：${pendingDoTags.join('、')}`);
      } else {
        rep.log(`模块 ${mod.id} DO 迁移已记账，本次不发（幂等重传）`);
      }
    }
    const moduleUpload = async (): Promise<void> =>
      uploadWorkerSpec(input, client, accountId, rep, {
        name: moduleWorkerName(mod.id),
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
    // 迁移已真正应用（上传 2xx）才记账：上传失败不记账 → 下次重发，而不是永久跳过（#255）
    if (doMigrations && doMigrationCp) {
      for (const tag of pendingDoTags) {
        await doMigrationCp.markMigrationApplied(mod.id, doMigrationLedgerName(tag));
      }
      // 同一次运行内的重传（secret 生效补 deploy）不再带已应用的迁移
      // ——重复 tag 会被 CF 拒（10079 Migration tag precondition failed）。
      doMigrations = undefined;
      pendingDoTags = [];
    }
    rep.log(`模块 ${mod.id} 已上传`);
    if (config.domain && resolvedZone) {
      await ensureRoute(client, resolvedZone.id, moduleRoutePattern(config.domain, mod.id), moduleWorkerName(mod.id), rep.log);
      rep.log(`模块 ${mod.id} 路由就绪（${moduleRoutePattern(config.domain, mod.id)}${isChat ? '，含前端产物 assets' : ''}）`);
    } else {
      // workers.dev 形态（#273）：模块自有子域是它的真实 URL；启用子域访问（CF 免费提供，无需 DNS/zone）
      await enableWorkersDev(client, accountId, moduleWorkerName(mod.id));
      rep.log(`模块 ${mod.id} 子域就绪（${moduleBaseUrlOf(mod.id)}，workers.dev）`);
    }
    if (isChat) {
      const hasKeyring = await hasWorkerSecret(client, accountId, moduleWorkerName(mod.id), CHAT_KEYRING_SECRET);
      if (!hasKeyring) {
        const keyring = generateChatKeyring();
        if (input.putSecret) {
          await input.putSecret(moduleWorkerName(mod.id), keyring, CHAT_KEYRING_SECRET);
          rep.log(`写入 secret ${CHAT_KEYRING_SECRET}（测试注入口）`);
        } else {
          await putWorkerSecret(client, accountId, moduleWorkerName(mod.id), CHAT_KEYRING_SECRET, keyring);
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

  // ④′ 未选模块（config 未列出但 lock 里有 = 上次装过）：删除其 zone 路由 /m/<id>/*。
  if (removedIds.length > 0) {
    if (!config.domain || !resolvedZone) {
      rep.log(`跳过未选模块路由删除（未配置 domain，无 zone 路由）：${removedIds.join('、')}`);
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
        moduleIds: removedIds,
        log: rep.log,
      });
    }
  }

  // ⑤ registry 写入（ControlPlane：与 core-api/SQLite 同一份 SQL，#64）
  rep.step(5, '注册表写入（选中 enabled，未选 not_deployed）');
  const manifestTexts: Record<string, string> = {};
  for (const mod of modules) {
    // #284：所有模块都经来源解析（official 目录扫描已删），manifest 原文一律来自解析产物。
    if (!mod.resolved) throw new Error(`模块 ${mod.id} 缺来源解析产物（引擎内部不一致）`);
    manifestTexts[mod.id] = mod.resolved.manifestText;
  }
  for (const mod of modules) {
    if (!mod.selected) continue;
    const manifest = buildManifestSnapshot({
      manifestText: manifestTexts[mod.id] ?? '',
      moduleId: mod.id,
      baseUrl,
      // #273：entry 按形态写模块**真实**可达 URL（workers.dev = 模块自有子域；domain = zone 路径）
      entry: moduleEntryUrl({
        domain: config.domain ?? '',
        workersDevSubdomain: workersDevAccountSubdomain,
        moduleId: mod.id,
        moduleWorkerName: moduleWorkerName(mod.id),
      }),
      ...(mod.resolved ? { manifest: mod.resolved.manifest } : {}),
    });
    // 存储选择（#55）写进快照：declaration 由 config 条目覆写（向导③½ / CLI），注册表快照即
    // 「这台实例上该模块数据在哪」的权威记录（core-api 门禁与运行时可读）。
    const configEntry = entries.find((e) => e.id === mod.id);
    const declaration = configEntry?.storage?.declaration;
    const snapshot = declaration
      ? { ...manifest, storage: { ...(manifest.storage ?? { accepts: [declaration] }), declaration } }
      : manifest;
    await coreCp.upsertModule({ id: mod.id, enabled: true, manifest: snapshot });
    rep.log(`upsert ${mod.id}（enabled=1，快照刷新${declaration ? `，落点 ${declaration}` : ''}）`);
  }
  for (const mod of removedIds.map((id) => ({ id }))) {
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
    // 资源台账（#272）：装配成功才写——撞车守卫下次据此判定归属（幂等重跑放行）。
    const ledger: ResourceLedger = {
      ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
      d1: [
        { name: coreDbName(), id: dbIds.core },
        { name: modulesDbName(), id: dbIds.modules },
        ...[...dedicatedDbIds].map(([id, dbId]) => ({ name: resourceName(id), id: dbId })),
      ],
      kv: chatResources ? [{ name: chatKvName(), id: chatResources.kvId }] : [],
      r2: [
        ...(config.storage.provider === 'r2' ? [{ name: config.storage.bucket }] : []),
        ...(chatMod ? [{ name: chatR2Name() }] : []),
      ],
      workers: [
        { name: coreWorkerName() },
        ...selected.map((m) => ({ name: moduleWorkerName(m.id) })),
      ],
    };
    const newLock: LockFile = {
      lockVersion: 1,
      generatedAt: new Date().toISOString(),
      modules: lockModules,
      resources: ledger,
    };
    await writeConfig(join(rootDir, LOCK_FILENAME), serializeLock(newLock));
    rep.log(`unself.lock 已更新（${Object.keys(lockModules).length} 个模块 + ${ledger.d1.length + ledger.kv.length + ledger.r2.length + ledger.workers.length} 个资源台账）`);
  }

  // ⑨ 冒烟 + 主题体检（§6.5.8 验产物）
  rep.step(9, '冒烟检查 /api/health 与各模块 health + 主题体检');
  const smoke = input.http
    ? await input.http.smoke(baseUrl, moduleTargets)
    : await smokeCheck({
        coreUrl: baseUrl,
        modules: moduleTargets,
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
      ? await input.http.themeCheck(baseUrl, moduleTargets)
      : []
    : await checkModuleThemes({
        modules: moduleTargets,
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
          db: chatDbName(),
          kv: chatKvName(),
          r2: chatR2Name(),
          keyringAction: chatKeyringAction!,
        }
      : undefined,
    setup: setup.status === 'sealed' ? { sealed: true as const } : { setupUrl: `/setup?token=${setup.token}` },
    keypairAction: freshPair ? 'created' : 'existing',
    themeChecks,
  };
}

/** 默认 REST 客户端：env token → 借 wrangler OAuth（决策 #65/#66，#246 起 resolveAuth 统一收口）。 */
async function defaultClient(log: (m: string) => void): Promise<{ client: RestClient; source: TokenSourceKind }> {
  const cred = await resolveAuth({ log });
  if (!cred) {
    throw new CredentialsMissingError(credentialsMissingMessage());
  }
  if (cred.warning) log(`⚠ ${cred.warning}`);
  return { client: new RestClient({ token: cred.token }), source: cred.source };
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

export { DEPLOY_DIR };
