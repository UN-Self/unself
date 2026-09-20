// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块卸载（#270，W4 验收④「卸载走生命周期端点导出与清理，验完库里无残留表」）。
 *
 * 卸载策略 = **平台按 `tables` 清单清理**（`@unself/contracts` 的
 * `MODULE_UNINSTALL_STRATEGY` / `platformUninstallPlan()` 是契约定案，不是本文件另定）：
 * 引擎只有「上传 Worker」通道，调不到模块入口对象；存量模块也没有 `/life/purge`。
 *
 * 执行顺序（硬）：
 *   ① 撤 zone 路由（domain 形态）→ ② 删模块 Worker → ③ 按注册表快照的
 *   `storage.declaration` + `manifest.tables` 清单 `DROP TABLE` → ④ 清该模块的迁移记账表
 *   （`unself_migrations_<id>`，#248/#255 同一套，**不另造第二套**）→ ⑤ 注册表删行
 *   （行没了 = `checkTokenGate` 404 = 该模块 token 失效）→ ⑥ 更新 `unself.lock` 台账。
 *
 * 「不许误删」硬规则：只删 `manifest.tables` 清单里的表 + 本模块记账表；
 * 保留表（module_registry / module_kv / setup_tokens / instance_config / sqlite_* /
 * _cf_* / 别人的 unself_migrations_*）一律拒绝；shared 落点额外要求 `<模块id>_` 前缀。
 *
 * 幂等：路由不存在/Worker 不存在/库不存在/注册表无该行 → 记日志继续，不报错。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ModuleManifestSchema, platformUninstallPlan, type PlatformUninstallPlan } from '@unself/contracts';
import { migrationsTableFor } from '@unself/control-plane';
import { writeConfig } from './assemble';
import { CredentialsMissingError, credentialsMissingMessage, resolveAuth } from './auth';
import { createCoreControlPlane } from './control-plane';
import { loadUnselfConfig, type UnselfConfig } from './config';
import { LOCK_FILENAME, parseLockText, serializeLock } from './lock';
import { dedicatedDbNameFor } from './migrate';
import { moduleRoutePattern } from './module-url';
import { registryDeleteSql } from './registry';
import {
  activeResourceNamespace,
  coreDbName,
  moduleWorkerName,
  modulesDbName,
  setResourceNamespace,
} from './naming';
import {
  CloudflareApiError,
  d1List,
  d1Query,
  deleteWorker,
  findAccountId,
  findZone,
  removeRoutesForPatterns,
  RestClient,
} from './rest';

/** 卸载结果（打印/断言用）。 */
export interface RemoveModuleResult {
  moduleId: string;
  /** 生效数据落点（注册表快照算得）。 */
  level: PlatformUninstallPlan['level'];
  /** 实际删除的表（清单内，逐个 DROP）。 */
  tablesDropped: string[];
  /** 被清的迁移记账表名（无则 null）。 */
  ledgerTable: string | null;
  routeRemoved: boolean;
  workerDeleted: boolean;
  removedFromRegistry: boolean;
  lockUpdated: boolean;
}

export interface RemoveModuleOptions {
  /** 实例目录（unself.lock / unself.config.jsonc 所在，与 runNineSteps 同一 rootDir 口径）。 */
  rootDir: string;
  moduleId: string;
  /** REST 客户端（测试注入；缺省由凭证解析新建）。 */
  client?: RestClient;
  /** 覆盖配置（测试注入；缺省 loadUnselfConfig(rootDir)）。 */
  configOverride?: UnselfConfig;
  log?: (msg: string) => void;
}

/** 保留表（绝不删）：core 的注册表/基建表 + 平台记账表 + SQLite/CF 内部表。 */
const RESERVED_TABLE_RE = /^(module_registry|module_kv|module_notify|setup_tokens|instance_config|sqlite_|_cf_|unself_migrations_)/;

/** 待删表名硬校验（防清单被写坏误删别的模块/平台表）。 */
export function assertDroppable(input: { moduleId: string; level: string; tables: string[] }): void {
  const prefix = `${input.moduleId.replaceAll('-', '_')}_`;
  for (const table of input.tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(table)) {
      throw new Error(`模块 ${input.moduleId} 的 tables 清单含非法表名 "${table}"——拒绝卸载（宁停不住）`);
    }
    if (RESERVED_TABLE_RE.test(table)) {
      throw new Error(
        `模块 ${input.moduleId} 的 tables 清单指向保留表 "${table}"——拒绝删除（模块不得申报平台/core 表）`,
      );
    }
    if (input.level === 'shared' && !table.startsWith(prefix)) {
      throw new Error(
        `模块 ${input.moduleId} 落点 shared 的表 "${table}" 不带模块前缀 ${prefix}——` +
          'shared 护栏③要求前缀；拒绝卸载（宁停不住）',
      );
    }
  }
}

/** 卸载主入口（命名空间状态只活在本次运行内，与 runNineSteps 同规）。 */
export async function removeModule(input: RemoveModuleOptions): Promise<RemoveModuleResult> {
  const config = input.configOverride ?? (await loadUnselfConfig(input.rootDir));
  const prevNamespace = activeResourceNamespace();
  setResourceNamespace(config.namespace);
  try {
    return await removeModuleInner(input, config);
  } finally {
    setResourceNamespace(prevNamespace);
  }
}

async function removeModuleInner(input: RemoveModuleOptions, config: UnselfConfig): Promise<RemoveModuleResult> {
  const { rootDir, moduleId } = input;
  const log = input.log ?? (() => {});
  const client = input.client ?? (await defaultClient(log));
  const accountId = await findAccountId(client);
  if (!accountId) throw new Error('无法解析 CF 账户（GET /accounts 失败或为空）——检查凭证');

  const workerName = moduleWorkerName(moduleId);
  const lockPath = join(rootDir, LOCK_FILENAME);
  const dbs = await d1List(client, accountId);
  const coreDb = dbs.find((db) => db.name === coreDbName());

  // ---- 读注册表快照（删表清单的唯一依据；读不到 → 只能做路由/Worker/删行，不能猜表） ----
  let plan: PlatformUninstallPlan = { moduleId, level: 'core', tables: [] };
  let registryFound = false;
  if (coreDb) {
    try {
      const coreCp = createCoreControlPlane(client, accountId, coreDb.uuid);
      const entry = (await coreCp.readRegistry()).find((m) => m.id === moduleId);
      if (entry && entry.manifest && typeof entry.manifest === 'object') {
        const manifest = ModuleManifestSchema.parse(entry.manifest);
        plan = platformUninstallPlan(manifest);
        registryFound = true;
        log(
          `注册表快照：${moduleId} 落点 ${plan.level}，tables 清单 ${plan.tables.length} 张` +
            (plan.tables.length > 0 ? `（${plan.tables.join('、')}）` : ''),
        );
      }
    } catch (err) {
      log(`注册表不可读（${err instanceof Error ? err.message : String(err)}）——跳过按清单删表`);
    }
  } else {
    log(`core 库 ${coreDbName()} 不存在——跳过注册表与按清单删表`);
  }
  if (!registryFound) {
    log(`注册表无模块 ${moduleId} 快照：按幂等处理（无清单可删，绝不猜表名）`);
  }

  assertDroppable({ moduleId, level: plan.level, tables: plan.tables });

  // ---- ① 撤 zone 路由（domain 形态；workers.dev 形态无路由） ----
  let routeRemoved = false;
  if (config.domain) {
    const zone = await findZone(client, config.domain);
    if (!zone) {
      log(`未解析到 ${config.domain} 的 zone——跳过路由删除（幂等）`);
    } else {
      await removeRoutesForPatterns(client, zone.id, [moduleRoutePattern(config.domain, moduleId)], log);
      routeRemoved = true;
    }
  } else {
    log('未配置 domain（workers.dev 形态）：无 zone 路由可撤');
  }

  // ---- ② 删模块 Worker（不存在 → 幂等） ----
  let workerDeleted = false;
  try {
    await deleteWorker(client, accountId, workerName);
    workerDeleted = true;
    log(`已删除模块 Worker ${workerName}`);
  } catch (err) {
    if (isMissingWorker(err)) {
      log(`模块 Worker ${workerName} 不存在（幂等）`);
    } else {
      throw err;
    }
  }

  // ---- ③④ 按 tables 清单删表 + 清本模块记账表（同一库：#248/#255 同一套记账） ----
  const tablesDropped: string[] = [];
  let ledgerTable: string | null = null;
  if (plan.level === 'shared' || plan.level === 'dedicated') {
    const targetName = plan.level === 'shared' ? modulesDbName() : dedicatedDbNameFor(moduleId);
    const target = dbs.find((db) => db.name === targetName);
    if (!target) {
      log(`落点 ${plan.level} 的库 ${targetName} 不存在——跳过表清理（幂等）`);
    } else {
      for (const table of plan.tables) {
        await d1Query(client, accountId, target.uuid, `DROP TABLE IF EXISTS "${table}"`);
        tablesDropped.push(table);
      }
      // 记账表（#55 护栏①）：卸完必须清——否则重装时迁移记账命中、表却不重建（永久缺表）
      ledgerTable = migrationsTableFor(moduleId);
      await d1Query(client, accountId, target.uuid, `DROP TABLE IF EXISTS "${ledgerTable}"`);
      log(
        `已清理 ${targetName}：` +
          (plan.tables.length > 0 ? `${plan.tables.join('、')}（${plan.tables.length} 张表）` : '无清单表') +
          ` + 记账表 ${ledgerTable}`,
      );
    }
  } else {
    log(`落点 ${plan.level}：平台不碰模块数据（core 的表归 core，external 归模块自己），无表可删`);
  }

  // ---- ⑤ 注册表删行（行没了 = checkTokenGate 404 = 该模块 token 失效） ----
  let removedFromRegistry = false;
  if (coreDb) {
    const res = await d1Query(client, accountId, coreDb.uuid, registryDeleteSql(), [moduleId]);
    removedFromRegistry = res.meta.changes > 0;
    log(removedFromRegistry ? `注册表已移除 ${moduleId}（该模块 token 自此失效）` : `注册表本无 ${moduleId}（幂等）`);
  }

  // ---- ⑥ 更新 unself.lock：去模块条目 + 去 worker 台账（保留其余资源台账） ----
  let lockUpdated = false;
  if (existsSync(lockPath)) {
    const lock = parseLockText(await readFile(lockPath, 'utf8'));
    const modules = { ...lock.modules };
    delete modules[moduleId];
    const resources = lock.resources ?? { d1: [], kv: [], r2: [], workers: [] };
    const next = {
      ...lock,
      generatedAt: new Date().toISOString(),
      modules,
      resources: { ...resources, workers: resources.workers.filter((w) => w.name !== workerName) },
    };
    await writeConfig(lockPath, serializeLock(next));
    lockUpdated = true;
    log('unself.lock 已更新（移除模块条目与 worker 台账）');
  }

  return {
    moduleId,
    level: plan.level,
    tablesDropped,
    ledgerTable,
    routeRemoved,
    workerDeleted,
    removedFromRegistry,
    lockUpdated,
  };
}

/** Worker 不存在（CF 404 / 10049）→ 幂等；其余错误照抛。 */
function isMissingWorker(err: unknown): boolean {
  if (err instanceof CloudflareApiError) {
    return err.status === 404 || err.code === 10049;
  }
  return false;
}

/** 默认 REST 客户端：env token → 借 wrangler OAuth（与九步同一套 resolveAuth）。 */
async function defaultClient(log: (m: string) => void): Promise<RestClient> {
  const cred = await resolveAuth({ log });
  if (!cred) {
    throw new CredentialsMissingError(credentialsMissingMessage());
  }
  if (cred.warning) log(`⚠ ${cred.warning}`);
  return new RestClient({ token: cred.token });
}
