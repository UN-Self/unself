// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SqliteControlPlane（#64 Docker 侧实现）：node:sqlite（Node ≥ 22.5 内置，零新依赖）
 * 跑 core 库建表 + 控制面读写；迁移记账按模块独立表（#55 护栏①）。
 * 行为与 D1 版语义一致：upsert 收敛、原子消费、记账按文件名跳过。
 */
import { DatabaseSync } from 'node:sqlite';
import { probeSqlite } from './sqlite-probe';
import {
  migrationsCreateSql,
  migrationsInsertIgnoreSql,
  migrationsInsertSql,
  migrationsListSql,
  REGISTRY_LIST_SQL,
  REGISTRY_TOGGLE_SQL,
  REGISTRY_UPSERT_SQL,
  SETUP_CONSUME_SQL,
  SETUP_INSERT_SQL,
  SETUP_RELEASE_SQL,
  SETUP_STATUS_SQL,
  SETUP_VALID_SQL,
} from './sql';
import { migrationsTableFor } from './types';
import type {
  ApplyReport,
  BoundQuery,
  ControlPlane,
  ControlPlaneExecutor,
  ModuleRegistration,
  RegistryEntry,
  SetupTokenIssue,
} from './types';

/** node:sqlite 的 null 原型行 → 普通对象（跨实现形状一致）。 */
function plainRow(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row };
}

/** node:sqlite → 控制面执行器（?N 序号占位符按位置绑定，run 回 meta.changes）。 */
class SqliteExecutor implements ControlPlaneExecutor {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): BoundQuery {
    const db = this.db;
    const stmt = db.prepare(sql);
    return {
      bind(...values: unknown[]) {
        return {
          async first<T>(): Promise<T | null> {
            const row = stmt.get(...(values as never[]));
            return (row === undefined ? null : (plainRow(row as Record<string, unknown>) as T)) ?? null;
          },
          async all<T>(): Promise<{ results: T[] }> {
            return {
              results: (stmt.all(...(values as never[])) as Array<Record<string, unknown>>).map((r) => plainRow(r) as T),
            };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            const info = stmt.run(...(values as never[]));
            return { meta: { changes: Number(info.changes) } };
          },
        };
      },
    };
  }
}

/** core 库形状（Docker 落点本地文件或 :memory:）。core 库不存在时：建表 = 控制面可独立工作（验收②）。 */
export function openCoreDb(path: string): { db: DatabaseSync; ensureSchema(): void } {
  const db = new DatabaseSync(path);
  return {
    db,
    ensureSchema(): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS instance_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS setup_tokens (
          token TEXT PRIMARY KEY,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          used_at TEXT,
          used_by TEXT
        );
        CREATE TABLE IF NOT EXISTS module_registry (
          id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 0,
          version TEXT,
          manifest_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_module_registry_enabled ON module_registry (enabled, id);
      `);
    },
  };
}

/** manifest 行 → RegistryEntry（enabled 0/1 → boolean；manifest JSON 容损坏回 null）。 */
export function rowToEntry(row: Record<string, unknown>): RegistryEntry {
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(String(row.manifest_json));
  } catch {
    manifest = null;
  }
  return {
    id: String(row.id),
    enabled: Number(row.enabled) === 1,
    version: row.version == null ? null : String(row.version),
    manifest,
  };
}

export class SqliteControlPlane implements ControlPlane {
  private readonly exec: SqliteExecutor;

  constructor(public readonly db: DatabaseSync) {
    this.exec = new SqliteExecutor(db);
  }

  /** 便捷构造：打开 + ensureSchema + 探测（node:sqlite 不可用给人话，不崩）。 */
  static open(path: string): SqliteControlPlane {
    const probe = probeSqlite();
    if (!probe.usable) {
      throw new Error(probe.reason);
    }
    const { db, ensureSchema } = openCoreDb(path);
    ensureSchema();
    return new SqliteControlPlane(db);
  }

  async upsertModule(reg: ModuleRegistration): Promise<RegistryEntry> {
    const version = reg.version ?? readManifestVersion(reg.manifest);
    const row = await this.exec
      .prepare(REGISTRY_UPSERT_SQL)
      .bind(reg.id, reg.enabled ? 1 : 0, version, JSON.stringify(reg.manifest))
      .first<Record<string, unknown>>();
    if (!row) throw new Error(`upsertModule 未返回行（id=${reg.id}）`);
    return rowToEntry(row);
  }

  async toggleModule(id: string, enabled: boolean): Promise<RegistryEntry | null> {
    const row = await this.exec
      .prepare(REGISTRY_TOGGLE_SQL)
      .bind(id, enabled ? 1 : 0)
      .first<Record<string, unknown>>();
    return row ? rowToEntry(row) : null;
  }

  async readRegistry(): Promise<RegistryEntry[]> {
    const { results } = await this.exec.prepare(REGISTRY_LIST_SQL).bind().all<Record<string, unknown>>();
    return results.map(rowToEntry);
  }

  async issueSetupToken(generate: () => string): Promise<SetupTokenIssue> {
    const row = await this.exec.prepare(SETUP_STATUS_SQL).bind().first<Record<string, unknown>>();
    if (Number(row?.sealed ?? 0) > 0) return { status: 'sealed' };
    const existing = typeof row?.token === 'string' && row.token.length > 0 ? row.token : null;
    if (existing) return { status: 'reused', token: existing };
    const token = generate();
    await this.exec.prepare(SETUP_INSERT_SQL).bind(token).run();
    return { status: 'created', token };
  }

  async isSetupTokenValid(token: string): Promise<boolean> {
    const row = await this.exec.prepare(SETUP_VALID_SQL).bind(token).first();
    return row != null;
  }

  async consumeSetupToken(token: string, usedBy: string): Promise<boolean> {
    const { meta } = await this.exec.prepare(SETUP_CONSUME_SQL).bind(token, usedBy).run();
    return meta.changes > 0;
  }

  /** 归还预占的 token（core-api builtin-admin 撞 UNIQUE 的补偿路径同语义）。 */
  async releaseSetupToken(token: string, usedBy: string): Promise<boolean> {
    const { meta } = await this.exec.prepare(SETUP_RELEASE_SQL).bind(token, usedBy).run();
    return meta.changes > 0;
  }

  async applyMigrations(module: string, files: Array<{ name: string; sql: string }>): Promise<ApplyReport> {
    // 记账表独立建（模块名白名单在 migrationsTableFor 内硬校验）
    this.db.exec(migrationsCreateSql(module));
    const applied = new Set(await this.appliedMigrations(module));
    const report: ApplyReport = { applied: [], skipped: [] };
    for (const file of files) {
      if (applied.has(file.name)) {
        report.skipped.push(file.name);
        continue;
      }
      // 逐文件：整份执行成功才记账（D1 无事务，同 core-api 范式：CREATE IF NOT EXISTS / OR IGNORE 幂等纪律）
      this.db.exec(file.sql);
      await this.exec.prepare(migrationsInsertSql(module)).bind(file.name).run();
      report.applied.push(file.name);
    }
    return report;
  }

  async appliedMigrations(module: string): Promise<string[]> {
    // 表未建（该模块尚无任何记账）→ 空账，不抛（与 RestD1ControlPlane 同语义）
    const table = migrationsTableFor(module);
    const exists = this.db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) return [];
    const { results } = await this.exec.prepare(migrationsListSql(module)).bind().all<{ name: unknown }>();
    return results.map((r) => String(r.name));
  }

  async markMigrationApplied(module: string, name: string): Promise<void> {
    // 与 applyMigrations 同一张表（#255）：非 SQL 事件（DO 迁移 tag）不另造记账
    this.db.exec(migrationsCreateSql(module));
    await this.exec.prepare(migrationsInsertIgnoreSql(module)).bind(name).run();
  }
}

/** manifest 形状未收紧时（unknown）的 version 兜底读取。 */
function readManifestVersion(manifest: unknown): string {
  if (manifest && typeof manifest === 'object' && 'version' in manifest) {
    const v = (manifest as Record<string, unknown>).version;
    if (typeof v === 'string' && v) return v;
  }
  return '0.0.0';
}
