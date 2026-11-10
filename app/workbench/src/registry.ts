// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

// 子路径进点（./types）：枚举与校验单点在 control-plane，且不把 node:sqlite 侧拖进 worker 打包图。
import {
  checkProvisioning,
  DEPLOY_MODES,
  STORAGE_LEVELS,
  type DeployMode,
  type StorageLevel,
} from '@unself/control-plane/types';
import { ModuleManifestSchema } from '@unself/contracts';

/**
 * 模块注册表（module_registry）API 契约：
 * deploy 脚本装配时写入（§5.5），运行时只翻转 enabled（启停秒级生效）。
 * manifest 存注册时的快照 JSON，运行期不回读模块源。
 */

/** 注册/更新请求体（deploy 脚本 → core-api）。 */
export const ModuleRegistrationSchema = z
  .object({
    /** 模块 id（表前缀/路由段/aud）。 */
    id: z.string().regex(/^[a-z][a-z0-9-]+$/),
    /** 是否启用（注册时默认按配置文件的选中状态）。 */
    enabled: z.boolean().default(true),
    /** 模块清单快照：注册时校验，运行期不回读。 */
    manifest: ModuleManifestSchema,
    /**
     * 落点三列（#348/#103② 用户实际选择，非 manifest 声明快照）。合并语义（#348 review 定案）：
     * 未写 = 保留列中旧值，清空必须显式传值（装配器/注册调用不承担清空）。
     * 注意不用 .default()：默认值会把「未写」变成「写了 cloudflare/null」，合并语义就没意义了。
     */
    mode: z.enum(DEPLOY_MODES).optional(),
    /** connect 模式的接入 URL；显式 null/空串 = 清空，缺字段 = 保留旧值。 */
    entry: z.preprocess(
      (v) => (v === '' ? null : v),
      z.string().nullish(),
    ),
    /** 存储四级（决策 #55）；显式 null/空串 = 清空（未选），缺字段 = 保留旧值。 */
    storage_level: z.preprocess(
      (v) => (v === '' ? null : v),
      z.enum(STORAGE_LEVELS).nullish(),
    ),
  })
  // 落点不变式与 0012 CHECK 同一规则（入口层给 400 人话，数据层是同一构成定义）：
  // 错误文案单点在 control-plane checkProvisioning，这里只透传。mode 未写 = 保留旧值，
  // 不参与本次核对（列中旧值在写入时已过 CHECK，不可能非法）。
  .superRefine((data, ctx) => {
    if (data.mode === undefined) return;
    const problem = checkProvisioning(data.mode, data.entry ?? null);
    if (problem) {
      ctx.addIssue({ code: 'custom', message: problem });
    }
  });

export type ModuleRegistration = z.infer<typeof ModuleRegistrationSchema>;

/** registry 行（API 响应形状；enabled 以 boolean 暴露，映射 D1 INTEGER 0/1）。 */
export interface RegistryEntry {
  id: string;
  enabled: boolean;
  version: string | null;
  manifest: unknown;
  /** 落点形态（#348）；缺省 cloudflare。 */
  mode: DeployMode;
  /** connect 模式接入 URL；其余模式 NULL。 */
  entry: string | null;
  /** 存储四级；NULL = 未选。 */
  storage_level: StorageLevel | null;
}

/** 启停响应。 */
export interface ToggleResult {
  id: string;
  enabled: boolean;
}

/** D1 行 → API 条目。 */
export function rowToEntry(row: {
  id: string;
  enabled: number;
  version: string | null;
  manifest_json: string;
  mode?: string | null;
  entry?: string | null;
  storage_level?: string | null;
}): RegistryEntry {
  let manifest: unknown;
  try {
    manifest = JSON.parse(row.manifest_json);
  } catch {
    manifest = null;
  }
  return {
    id: row.id,
    enabled: row.enabled === 1,
    version: row.version,
    manifest,
    mode: (row.mode ?? 'cloudflare') as DeployMode,
    entry: row.entry ?? null,
    storage_level: (row.storage_level ?? null) as StorageLevel | null,
  };
}

/**
 * 注册或更新（upsert）：manifest 快照随注册刷新，enabled 按请求给；
 * 落点三列合并语义（#348 review 定案）：本次未写 = 保留列中旧值，RETURNING 回合并后的真行。
 */
export async function upsertModule(db: D1Database, reg: ModuleRegistration): Promise<RegistryEntry> {
  const manifestJson = JSON.stringify(reg.manifest);
  const row = await db
    .prepare(
      `INSERT INTO module_registry (id, enabled, version, manifest_json, mode, entry, storage_level) VALUES (?1, ?2, ?3, ?4, coalesce(?5, 'cloudflare'), ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, version = excluded.version, manifest_json = excluded.manifest_json,
       mode = coalesce(?5, mode), entry = coalesce(?6, CASE WHEN coalesce(?5, mode) = 'connect' THEN entry END), storage_level = coalesce(?7, storage_level)
       RETURNING id, enabled, version, manifest_json, mode, entry, storage_level`,
    )
    .bind(
      reg.id,
      reg.enabled ? 1 : 0,
      reg.manifest.version,
      manifestJson,
      reg.mode ?? null,
      reg.entry ?? null,
      reg.storage_level ?? null,
    )
    .first<{ id: string; enabled: number; version: string | null; manifest_json: string; mode: string | null; entry: string | null; storage_level: string | null }>();
  if (!row) {
    throw new Error(`upsertModule 未返回行（id=${reg.id}）`);
  }
  return rowToEntry(row);
}

/** 翻转启停（运行时秒级生效：边栏隐藏 + token 门禁拒发，§5.5）。 */
export async function toggleModule(db: D1Database, id: string, enabled: boolean): Promise<ToggleResult | null> {
  const row = await db
    .prepare('UPDATE module_registry SET enabled = ? WHERE id = ? RETURNING id, enabled')
    .bind(enabled ? 1 : 0, id)
    .first<{ id: string; enabled: number }>();
  if (!row) {
    return null;
  }
  return { id: row.id, enabled: row.enabled === 1 };
}

/** 列出全部模块（管理端；成员侧由 shell 过滤 enabled）。 */
export async function listModules(db: D1Database): Promise<RegistryEntry[]> {
  // 列集合与迁移 0001 建表严格一致（旧版 RegistryEntry 带不存在于 DB 的注册时间幻影字段，
  // 响应恒返空串——已删；真列 SELECT 可暴露查询列 ↔ 建表列错位）。
  const result = await db
    .prepare('SELECT id, enabled, version, manifest_json, mode, entry, storage_level FROM module_registry ORDER BY id')
    .all<{ id: string; enabled: number; version: string | null; manifest_json: string; mode: string | null; entry: string | null; storage_level: string | null }>();
  return result.results.map(rowToEntry);
}

/**
 * URL → origin 归一化（决策 #63/#73 白名单统一口径）：
 * https://team.example.com/m/hello/ → https://team.example.com
 * 端口按 URL 标准保留（非默认端口是 origin 的一部分）；非 http(s) 协议 → null；解析失败 → null。
 */
export function normalizeFrameOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * 注册表 → 外壳 frame-src 白名单 origin 集合（决策 #63/#73）：
 * 全模块 manifest.entry 的 origin，去掉实例自身 origin（同域路径制已由 'self' 覆盖）。
 * 只信「解析成功」的 http(s) entry；坏值/坏协议静默跳过——白名单宁可窄不可宽。
 */
export async function registryFrameOrigins(
  db: D1Database,
  options: { selfOrigin?: string | null } = {},
): Promise<string[]> {
  const rows = await db
    .prepare('SELECT manifest_json FROM module_registry WHERE enabled = 1')
    .all<{ manifest_json: string }>();
  const origins = new Set<string>();
  for (const row of rows.results) {
    try {
      const manifest = JSON.parse(row.manifest_json) as { entry?: unknown };
      if (typeof manifest.entry !== 'string') continue;
      const origin = normalizeFrameOrigin(manifest.entry);
      if (origin && origin !== options.selfOrigin) origins.add(origin);
    } catch {
      // 快照损坏 ≠ 放宽白名单：跳过该行
    }
  }
  return [...origins].sort();
}
