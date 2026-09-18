// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 控制面 SQL 单点（#64：core 与装配器共用同一份，防漂移）：
 * - module_registry upsert / toggle / list（与 core-api 迁移 0001 建表列严格一致）；
 * - setup token 探测 / 签发 / 原子消费 / 归还 / 校验（0002 建表列）；
 * - 按模块独立迁移记账（#55 护栏①：表名 unself_migrations_<module>）。
 * 全部占位符用 ?1/?2 序号形式——D1 与 node:sqlite 都支持，读侧各自绑定执行器。
 */
import { migrationsTableFor } from './types';

// ---- module_registry（core 库 0001）----

export const REGISTRY_UPSERT_SQL = `INSERT INTO module_registry (id, enabled, version, manifest_json)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(id) DO UPDATE SET
  enabled = excluded.enabled,
  version = excluded.version,
  manifest_json = excluded.manifest_json
RETURNING id, enabled, version, manifest_json`;

export const REGISTRY_TOGGLE_SQL =
  'UPDATE module_registry SET enabled = ?2 WHERE id = ?1 RETURNING id, enabled, version, manifest_json';

export const REGISTRY_LIST_SQL =
  'SELECT id, enabled, version, manifest_json FROM module_registry ORDER BY id';

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
