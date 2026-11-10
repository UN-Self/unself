// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 控制面 SQL 单点（#64：core 与装配器共用同一份，防漂移）：
 * - module_registry upsert / toggle / list（与 core-api 迁移 0001 建表列严格一致）；
 * - setup token 探测 / 签发 / 原子消费 / 归还 / 校验（0002 建表列）；
 * - 按模块独立迁移记账（#55 护栏①：表名 unself_migrations_<module>）。
 * 全部占位符用 ?1/?2 序号形式——D1 与 node:sqlite 都支持，读侧各自绑定执行器。
 */
import { migrationsTableFor, type ModuleRegistration } from './types';

// ---- module_registry（core 库 0001 建表 + 0012 落点三列）----

/**
 * upsert 冲突分支合并语义（#348 review 定案，#103②「用户实际选择」的构成定义）：
 * 落点三列要活过模块升级——本次未写（绑定值为 NULL）保留列中旧值，清空必须走显式写值
 * （管理接口/管理动作），装配器不承担清空职责。首次插入的缺省值（mode='cloudflare'）由
 * VALUES 里的 coalesce 承载（列 DEFAULT 不救显式 NULL）；冲突分支引用原始绑定值与目标行
 * 现值合并，不复用被 coerce 过的 excluded.*（否则会把「未写」变成「写默认值」）。同一 ?N
 * 可多处引用，bind 数仍是 7（D1 与 node:sqlite 同语义，三实现共用）。
 * enabled/version/manifest_json 仍随注册刷新。
 */
export const REGISTRY_UPSERT_SQL = `INSERT INTO module_registry (id, enabled, version, manifest_json, mode, entry, storage_level)
VALUES (?1, ?2, ?3, ?4, coalesce(?5, 'cloudflare'), ?6, ?7)
ON CONFLICT(id) DO UPDATE SET
  enabled = excluded.enabled,
  version = excluded.version,
  manifest_json = excluded.manifest_json,
  mode = coalesce(?5, mode),
  entry = coalesce(?6, CASE WHEN coalesce(?5, mode) = 'connect' THEN entry END),
  storage_level = coalesce(?7, storage_level)
RETURNING id, enabled, version, manifest_json, mode, entry, storage_level`;

export const REGISTRY_TOGGLE_SQL =
  'UPDATE module_registry SET enabled = ?2 WHERE id = ?1 RETURNING id, enabled, version, manifest_json, mode, entry, storage_level';

export const REGISTRY_LIST_SQL =
  'SELECT id, enabled, version, manifest_json, mode, entry, storage_level FROM module_registry ORDER BY id';

/**
 * upsert 绑参：三列按本次请求透传，未写（undefined）归一为 NULL = 保留旧值（#348 review 定案）。
 * 不再补默认值——「装配器没填」≠「用户选了 cloudflare」，首次插入的默认值由 0012 列 DEFAULT 承载。
 */
export function provisioningBinds(reg: ModuleRegistration): [string | null, string | null, string | null] {
  return [reg.mode ?? null, reg.entry ?? null, reg.storage_level ?? null];
}

// ---- setup_tokens（core 库 0002）----

/** 一次往返拿「是否已封箱」+「可复用的未消费 token」（装配器步骤⑧重跑幂等）。 */
export const SETUP_STATUS_SQL =
  "SELECT (SELECT COUNT(*) FROM instance_config WHERE key = 'setup_done' AND value = '1') AS sealed, " +
  '(SELECT token FROM setup_tokens WHERE used_at IS NULL ORDER BY created_at LIMIT 1) AS token';

export const SETUP_INSERT_SQL = 'INSERT INTO setup_tokens (token) VALUES (?1)';

/** 原子消费：并发双激活只有一次 changes=1（core-api setup.ts 同语义，此处 SQL 单点化）。 */
export const SETUP_CONSUME_SQL =
  "UPDATE setup_tokens SET used_at = datetime('now'), used_by = ?2 WHERE token = ?1 AND used_at IS NULL";

export const SETUP_RELEASE_SQL =
  'UPDATE setup_tokens SET used_at = NULL, used_by = NULL WHERE token = ?1 AND used_by = ?2 AND used_at IS NOT NULL';

export const SETUP_VALID_SQL = 'SELECT 1 AS ok FROM setup_tokens WHERE token = ?1 AND used_at IS NULL';

// ---- 迁移记账（每模块独立表，#55）----

export function migrationsCreateSql(module: string): string {
  return `CREATE TABLE IF NOT EXISTS ${migrationsTableFor(module)} (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
}

export function migrationsInsertSql(module: string): string {
  return `INSERT INTO ${migrationsTableFor(module)} (name) VALUES (?1)`;
}

/** 幂等记账写入（非 SQL 迁移事件，如 DO 迁移 tag；#255 与文件记账同表）。 */
export function migrationsInsertIgnoreSql(module: string): string {
  return `INSERT OR IGNORE INTO ${migrationsTableFor(module)} (name) VALUES (?1)`;
}

export function migrationsListSql(module: string): string {
  return `SELECT name FROM ${migrationsTableFor(module)} ORDER BY name`;
}
