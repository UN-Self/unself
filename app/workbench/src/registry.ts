// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

// 子路径进点（./types）：枚举与校验单点在 control-plane，且不把 node:sqlite 侧拖进 worker 打包图。
import {
  CREDENTIAL_HASH_PATTERN,
  checkProvisioning,
  DEPLOY_MODES,
  STORAGE_LEVELS,
  type DeployMode,
  type StorageLevel,
} from '@unself/control-plane/types';
import { ModuleManifestSchema, type ModuleManifest } from '@unself/contracts';

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
    /** 存储落点两值（#349 U5）；显式 null/空串 = 清空（未选，undefined = self），缺字段 = 保留旧值。 */
    storage_level: z.preprocess(
      (v) => (v === '' ? null : v),
      z.enum(STORAGE_LEVELS).nullish(),
    ),
    /** 反连凭证哈希（#349）：64 位小写 hex；未写 = 保留旧值（合并语义同落点三列）。 */
    credential_hash: z.preprocess(
      (v) => (v === '' ? null : v),
      z.string().regex(CREDENTIAL_HASH_PATTERN).nullish(),
    ),
  })
  // #349 U9：entry 列成为地址真值面后的 #63 锚点（原在清单 manifest.entry，U9 移出清单）。
  // 公网明文 http 拒收（仅 localhost/127.0.0.1/[::1] 明文豁免）——external 模块经浏览器装载,
  // 明文公网地址等于令牌裸华；非 http(s)/不可解析也拒（白名单/装载都消费不了）。
  .superRefine((data, ctx) => {
    if (data.entry) {
      let url: URL | null = null;
      try {
        url = new URL(data.entry);
      } catch {
        url = null;
      }
      if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
        ctx.addIssue({ code: 'custom', path: ['entry'], message: `entry=${data.entry} 不是可解析的 http(s) URL` });
      } else if (!url.protocol.startsWith('https')) {
        const host = url.hostname;
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
        if (!isLocal) {
          ctx.addIssue({
            code: 'custom',
            path: ['entry'],
            message: `entry=${data.entry} 非 https（决策 #63 publicUrl 强制 https；仅 localhost/127.0.0.1 明文豁免）`,
          });
        }
      }
    }
    if (data.mode === undefined) return;
    const problem = checkProvisioning(data.mode, data.entry ?? null);
    if (problem) {
      ctx.addIssue({ code: 'custom', message: problem });
    }
  });

export type ModuleRegistration = z.infer<typeof ModuleRegistrationSchema>;

/**
 * 反连接入记账请求体（#349，决策 #108 两段式第①段）。
 * keyHash = 浏览器 hex(SHA-256(key))，形状单点在 control-plane CREDENTIAL_HASH_PATTERN；
 * storageLevel 可选两值（core|self；#349 U5。用户此时可能还没选存储，未写 = 保留列中旧值，合并语义同落点三列）。
 */
export const ConnectRegisterSchema = z.object({
  moduleId: z.string().regex(/^[a-z][a-z0-9-]+$/),
  keyHash: z.string().regex(CREDENTIAL_HASH_PATTERN),
  storageLevel: z.enum(STORAGE_LEVELS).optional(),
});

/**
 * connect 记账 pending 态的 manifest 占位快照（#349）：ModuleManifestSchema 的最小合法形状。
 * 决策 #108 两段式中本段不携带真清单（模块还没部署）；真快照由第②段「测试连接→保存」
 * 的 POST /api/admin/modules 写入并覆盖此占位。地址面只在 entry 列（U9：清单不承载地址），
 * credential_hash 列（非快照）才是凭证真值面。
 */
export function connectPendingManifest(moduleId: string): z.infer<typeof ModuleManifestSchema> {
  return ModuleManifestSchema.parse({
    id: moduleId,
    version: '0.0.0',
    runtimes: ['external'],
    route: `/m/${moduleId}`,
  });
}

/** 注册表行（API 响应形状；enabled 以 boolean 暴露，映射 D1 INTEGER 0/1）。 */
export interface RegistryEntry {
  id: string;
  enabled: boolean;
  version: string | null;
  manifest: unknown;
  /** 落点形态（#348）；缺省 cloudflare。 */
  mode: DeployMode;
  /** connect 模式接入 URL；其余模式 NULL。 */
  entry: string | null;
  /** 存储落点两值（core|self，#349 U5）；NULL = 未选。 */
  storage_level: StorageLevel | null;
  /** 反连凭证哈希（#349，决策 #108）；mode=connect 且完成保存后必有值。 */
  credential_hash: string | null;
}

/**
 * 成员侧模块条目（GET /api/modules，#348 遗留收窄，#349）：不回 mode/storage_level/credential_hash。
 * 排除面 = 0012 落点三列中的 mode/storage_level + 0013 credential_hash（凭证敏感面，
 * 管理员视角才有，GET /api/admin/modules）。**entry 例外面（#349 U9）**：清单不再承载地址后
 * 壳 iframe 装载（moduleFrameSrc）唯一地址源 = 本字段，回注册表 entry 列（core 隧道路由 /
 * 装配器写入的实例地址）。manifest 保留：nav 图标（manifest.icon）等消费它。
 * name = manifest.description ?? id（描述缺省时给可读名；描述进 manifest 由 contracts schema 掌握）。
 */
export interface MemberModuleEntry {
  id: string;
  enabled: boolean;
  name: string;
  manifest: unknown;
  /** 装载地址（#349 U9 唯一落点字段）：注册表 entry 列原值；未写（如从未记账的 CF 存量行）→ null。 */
  entry: string | null;
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
  credential_hash?: string | null;
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
    credential_hash: row.credential_hash ?? null,
  };
}

/**
 * 注册或更新（upsert）：manifest 快照随注册刷新，enabled 按请求给；
 * 落点三列合并语义（#348 review 定案）：本次未写 = 保留列中旧值，RETURNING 回合并后的真行。
 * #349 U9：快照不含地址（schema 已剥 entry 键）；entry 列才是地址真值面（CF=装配器写、
 * connect=connect-register 写 core 隧道路由）。
 */
export async function upsertModule(db: D1Database, reg: ModuleRegistration): Promise<RegistryEntry> {
  const manifestJson = JSON.stringify(reg.manifest);
  const row = await db
    .prepare(
      `INSERT INTO module_registry (id, enabled, version, manifest_json, mode, entry, storage_level, credential_hash) VALUES (?1, ?2, ?3, ?4, coalesce(?5, 'cloudflare'), ?6, ?7, ?8)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, version = excluded.version, manifest_json = excluded.manifest_json,
       mode = coalesce(?5, mode), entry = coalesce(?6, CASE WHEN coalesce(?5, mode) = 'connect' THEN entry END), storage_level = coalesce(?7, storage_level),
       credential_hash = coalesce(?8, credential_hash)
       RETURNING id, enabled, version, manifest_json, mode, entry, storage_level, credential_hash`,
    )
    .bind(
      reg.id,
      reg.enabled ? 1 : 0,
      reg.manifest.version,
      manifestJson,
      reg.mode ?? null,
      reg.entry ?? null,
      reg.storage_level ?? null,
      reg.credential_hash ?? null,
    )
    .first<{ id: string; enabled: number; version: string | null; manifest_json: string; mode: string | null; entry: string | null; storage_level: string | null; credential_hash: string | null }>();
  if (!row) {
    throw new Error(`upsertModule 未返回行（id=${reg.id}）`);
  }
  return rowToEntry(row);
}

// ---- 模块配置值（#349 U8 ④）：manifest.config 声明（快照内）与用户存值（0015 列）分存 ----

/**
 * 模块配置读态：字段声明（manifest.config）+ 已存值（config_values）。
 * 无声明 / 无存值 / 快照或存值损坏 → 各自回落空（不 404，空态是合法状态）。
 */
export interface ModuleConfigState {
  config: Array<{ key: string; type: string; required?: boolean; options?: string[]; [k: string]: unknown }>;
  values: Record<string, unknown>;
}

/**
 * 读模块配置（admin GET 与 module-api GET 共用单点）。
 * manifest_json.config 损坏/非数组 → 空 config（fail-closed：没声明就没字段可校验可渲染）；
 * config_values 为 NULL → 空对象；损坏 JSON → 空对象（不抛，空态语义同上）。
 */
export async function getModuleConfig(db: D1Database, id: string): Promise<ModuleConfigState | null> {
  const row = await db
    .prepare('SELECT manifest_json, config_values FROM module_registry WHERE id = ?')
    .bind(id)
    .first<{ manifest_json: string; config_values: string | null }>();
  if (!row) return null;
  type ConfigFieldRow = { key: string; type: string; required?: boolean; options?: string[]; [k: string]: unknown };
  let config: ConfigFieldRow[] = [];
  try {
    const manifest = JSON.parse(row.manifest_json) as { config?: unknown };
    if (Array.isArray(manifest.config)) {
      // 快照在注册时已过 ModuleManifestSchema；这里只做形状容错（非对象/缺 key 元素丢弃）
      config = manifest.config.filter(
        (f): f is ConfigFieldRow => typeof f === 'object' && f !== null && typeof (f as { key?: unknown }).key === 'string',
      );
    }
  } catch {
    config = [];
  }
  let values: Record<string, unknown> = {};
  if (row.config_values) {
    try {
      const parsed = JSON.parse(row.config_values) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        values = parsed as Record<string, unknown>;
      }
    } catch {
      values = {};
    }
  }
  return { config, values };
}

/**
 * 存模块配置值（admin PUT 的写面）：整列覆盖写（调用方已按 manifest.config schema
 * 校验过 values）。行不存在返回 false（调用方 404）；重放同一 values 幂等。
 */
export async function saveModuleConfig(db: D1Database, id: string, values: Record<string, unknown>): Promise<boolean> {
  const result = await db
    .prepare('UPDATE module_registry SET config_values = ? WHERE id = ?')
    .bind(JSON.stringify(values), id)
    .run();
  return result.meta.changes > 0;
}

/**
 * 模块自报 manifest（#349 U8 ①）：connect 模块 ready 后把完整清单快照 POST 上来，
 * 覆盖 connect-register 记账的 0.0.0 占位。moduleId 以 keyHash 反查为准（调用方已查），
 * body 里的 id 不信任；entry 同理丢弃（#349 U9：body 若带野 entry，schema 对象层剥掉，
 * 落库快照不含地址，entry 列维持 core 隧道路由不被污染）。定向 UPDATE manifest_json + version，
 * 不碰 enabled/落点列。返回 false = 行不存在（调用方 404）。
 */
export async function updateModuleManifest(db: D1Database, moduleId: string, manifest: ModuleManifest): Promise<boolean> {
  const result = await db
    .prepare('UPDATE module_registry SET manifest_json = ?, version = ? WHERE id = ?')
    .bind(JSON.stringify(manifest), manifest.version, moduleId)
    .run();
  return result.meta.changes > 0;
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

/** 列出全部模块（管理端，含停用；成员侧由 GET /api/modules 收窄）。 */
export async function listModules(db: D1Database): Promise<RegistryEntry[]> {
  // 列集合与迁移 0001 建表严格一致（历史幻影列教训：响应恒返空串——已删；真列 SELECT 可暴露查询列 ↔ 建表列错位）。
  const result = await db
    .prepare('SELECT id, enabled, version, manifest_json, mode, entry, storage_level, credential_hash FROM module_registry ORDER BY id')
    .all<{ id: string; enabled: number; version: string | null; manifest_json: string; mode: string | null; entry: string | null; storage_level: string | null; credential_hash: string | null }>();
  return result.results.map(rowToEntry);
}

/**
 * 成员侧启用清单（GET /api/modules，#348 遗留收窄，#349 U9）：不回 mode/storage_level/credential_hash。
 * 语义：只回 enabled 行；每行回 id/enabled/name/manifest/entry——entry 是壳 iframe 装载
 * 的唯一地址源（注册表 entry 列原值，U9 起清单不再承载地址）；mode/storage_level/credential_hash
 * 继续不回。需要完整条目走管理端 GET /api/admin/modules（requireAdmin）。
 */
export async function listMemberModules(db: D1Database): Promise<MemberModuleEntry[]> {
  const rows = await db
    .prepare('SELECT id, enabled, manifest_json, entry FROM module_registry WHERE enabled = 1 ORDER BY id')
    .all<{ id: string; enabled: number; manifest_json: string; entry: string | null }>();
  return rows.results.map((row) => ({
    id: row.id,
    enabled: row.enabled === 1,
    name: memberModuleName(row.manifest_json) || row.id,
    manifest: memberModuleManifest(row.manifest_json),
    entry: row.entry ?? null,
  }));
}

/** 成员侧条目名：manifest.description；缺省/非字符串/快照损坏 → 空串（调用方回退 id）。 */
function memberModuleName(manifestJson: string): string {
  try {
    const manifest = JSON.parse(manifestJson) as { description?: unknown };
    return typeof manifest.description === 'string' ? manifest.description : '';
  } catch {
    return '';
  }
}

/** 成员侧条目 manifest：解析快照；损坏回 null（与 rowToEntry 同口径，不外泄原始串）。 */
function memberModuleManifest(manifestJson: string): unknown {
  try {
    return JSON.parse(manifestJson);
  } catch {
    return null;
  }
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
 * 注册表 → 外壳 frame-src 白名单 origin 集合（决策 #63/#73，#349 U9 换真值源）：
 * 只读注册表 entry 列（地址真值面；清单不再承载地址），去掉实例自身 origin
 * （同域路径制已由 'self' 覆盖）。只信「解析成功」的 http(s) entry；
 * 坏值/坏协议/空值静默跳过——白名单宁可窄不可宽。
 */
export async function registryFrameOrigins(
  db: D1Database,
  options: { selfOrigin?: string | null } = {},
): Promise<string[]> {
  const rows = await db
    .prepare('SELECT entry FROM module_registry WHERE enabled = 1')
    .all<{ entry: string | null }>();
  const origins = new Set<string>();
  for (const row of rows.results) {
    if (!row.entry) continue;
    const origin = normalizeFrameOrigin(row.entry);
    if (origin && origin !== options.selfOrigin) origins.add(origin);
  }
  return [...origins].sort();
}
