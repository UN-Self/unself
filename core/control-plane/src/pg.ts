// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PgControlPlane（#360 轨道 B）：PostgreSQL 作为 core 数据库的一等实现。
 *
 * 与 SqliteControlPlane 形状完全对齐，共用 sql.ts 的同一份 SQL（`?N` 序号占位符）；
 * 方言差异只在执行器边界处理：
 * - `?N` → `$N`（placeholder.ts）；
 * - `datetime('now')` → `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
 *   （core 的文本时间语义是 `YYYY-MM-DD HH:MM:SS` UTC，与 D1 / node:sqlite 同形状；
 *   PG 的 CURRENT_TIMESTAMP 会带 `+00` 后缀，形状不一致）；
 * - `INSERT OR IGNORE` → `INSERT … ON CONFLICT DO NOTHING`。
 *
 * 迁移记账与 SQLite 版同语义（#55 护栏①）：`unself_migrations_<module>` 按文件名记账、
 * 整份成功才记；文件名去掉 `.pg` 后作为键（`0017_x.pg.sql` → 记 `0017_x.sql`），
 * 两种方言的账对齐。PG 支持事务：每个迁移文件 + 记账包在一个事务里，失败 ROLLBACK
 * 不记账——这是 D1（无事务）拿不到的额外保证。
 */
import { Pool } from 'pg';
import { toPgPlaceholders } from './placeholder';
import {
  migrationsCreateSql,
  migrationsInsertIgnoreSql,
  migrationsInsertSql,
  migrationsListSql,
  provisioningBinds,
  REGISTRY_LIST_SQL,
  REGISTRY_TOGGLE_SQL,
  REGISTRY_UPSERT_SQL,
  SETUP_CONSUME_SQL,
  SETUP_INSERT_SQL,
  SETUP_RELEASE_SQL,
  SETUP_STATUS_SQL,
  SETUP_VALID_SQL,
} from './sql';
import { rowToEntry } from './sqlite';
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

/** core 文本时间语义（与 D1 / node:sqlite 的 `datetime('now')` 同形状）。 */
const PG_TEXT_NOW = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')";

/**
 * SQL 文本 → PG 可执行文本（纯改写，不改语义）：
 * 占位符 + 时间默认值 + `INSERT OR IGNORE` 三处方言点。仅在 PG 执行器边界调用；
 * 迁移文件本体已是 PG 方言，不经此处。
 */
export function toPgSql(sql: string): string {
  const placeholders = toPgPlaceholders(sql);
  const dated = placeholders.replace(/datetime\s*\(\s*'now'\s*\)/gi, PG_TEXT_NOW);
  return rewriteInsertOrIgnore(dated);
}

/** `INSERT OR IGNORE INTO …` → `INSERT INTO … ON CONFLICT DO NOTHING`（本包语句无 RETURNING）。 */
function rewriteInsertOrIgnore(sql: string): string {
  if (!/^\s*INSERT\s+OR\s+IGNORE\b/i.test(sql)) return sql;
  const body = sql
    .replace(/^(\s*)INSERT\s+OR\s+IGNORE\b/i, '$1INSERT')
    .trimEnd()
    .replace(/;\s*$/, '');
  return `${body} ON CONFLICT DO NOTHING`;
}

/** 迁移文件名 → 记账键（两种方言记同一个名字）。 */
function ledgerName(fileName: string): string {
  return fileName.replace(/\.pg\.sql$/, '.sql');
}

/**
 * PG 查询面（`Pool` 与 `PoolClient` 都满足）：事务内必须用 client，否则语句会被
 * pool 派发到别的连接上、事务形同虚设（`toD1Database` 的 batch 依赖这一点）。
 */
export interface PgQueryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** 控制面执行器（ControlPlaneExecutor）：与 D1 语义一致——first 无行 null / all 回 results / run 回 changes。 */
export class PgExecutor implements ControlPlaneExecutor {
  constructor(private readonly db: PgQueryable) {}

  prepare(sql: string): BoundQuery {
    const text = toPgSql(sql);
    const db = this.db;
    return {
      bind(...values: unknown[]) {
        const params = values as unknown[];
        return {
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            const result = await db.query(text, params);
            return (result.rows[0] as T | undefined) ?? null;
          },
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            const result = await db.query(text, params);
            return { results: result.rows as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            const result = await db.query(text, params);
            return { meta: { changes: result.rowCount ?? 0 } };
          },
        };
      },
    };
  }
}

export class PgControlPlane implements ControlPlane {
  private readonly exec: PgExecutor;

  constructor(public readonly pool: Pool) {
    this.exec = new PgExecutor(pool);
  }

  /** 便捷构造：打开连接池 + 建 core 基础表（与 SqliteControlPlane.open 的 ensureSchema 同形）。 */
  static async open(connectionString: string): Promise<PgControlPlane> {
    const pool = new Pool({ connectionString });
    const cp = new PgControlPlane(pool);
    await cp.ensureCoreSchema();
    return cp;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * core 基础表（对应迁移 0001/0002 + 0012–0017 后的列集）：与 sqlite.ts 的 openCoreDb
   * 同形，让控制面在迁移尚未跑时也能独立工作（验收②）。
   */
  async ensureCoreSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS instance_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (${PG_TEXT_NOW})
      );
      CREATE TABLE IF NOT EXISTS setup_tokens (
        token TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (${PG_TEXT_NOW}),
        used_at TEXT,
        used_by TEXT
      );
      CREATE TABLE IF NOT EXISTS module_registry (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        version TEXT,
        manifest_json TEXT NOT NULL,
        entry TEXT,
        storage_level TEXT,
        mode TEXT NOT NULL DEFAULT 'direct'
          CHECK (mode IN ('direct', 'connect') AND (mode != 'connect' OR entry IS NOT NULL)),
        credential_hash TEXT,
        config_values TEXT,
        lifecycle TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_module_registry_enabled ON module_registry (enabled, id);
    `);
  }

  async upsertModule(reg: ModuleRegistration): Promise<RegistryEntry> {
    const version = reg.version ?? readVersion(reg.manifest);
    const [mode, entry, storageLevel, credentialHash] = provisioningBinds(reg);
    const row = await this.exec
      .prepare(REGISTRY_UPSERT_SQL)
      .bind(reg.id, reg.enabled ? 1 : 0, version, JSON.stringify(reg.manifest), mode, entry, storageLevel, credentialHash)
      .first<Record<string, unknown>>();
    if (!row) throw new Error(`upsertModule 未返回行（id=${reg.id}）`);
    return rowToEntry(row);
  }

  async toggleModule(id: string, enabled: boolean): Promise<RegistryEntry | null> {
    const row = await this.exec.prepare(REGISTRY_TOGGLE_SQL).bind(id, enabled ? 1 : 0).first<Record<string, unknown>>();
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

  async releaseSetupToken(token: string, usedBy: string): Promise<boolean> {
    const { meta } = await this.exec.prepare(SETUP_RELEASE_SQL).bind(token, usedBy).run();
    return meta.changes > 0;
  }

  async applyMigrations(module: string, files: Array<{ name: string; sql: string }>): Promise<ApplyReport> {
    await this.exec.prepare(migrationsCreateSql(module)).bind().run();
    const applied = new Set(await this.appliedMigrations(module));
    const report: ApplyReport = { applied: [], skipped: [] };
    for (const file of files) {
      const key = ledgerName(file.name);
      if (applied.has(key)) {
        report.skipped.push(file.name);
        continue;
      }
      await this.applyMigrationFile(module, key, file.sql);
      report.applied.push(file.name);
    }
    return report;
  }

  /**
   * 单个文件 + 记账原子提交：BEGIN → 整份 SQL → 记一行 → COMMIT；任一步失败 ROLLBACK
   * （文件不记账，重跑整份重放）。迁移文件已含多条语句，无参 query 走简单查询协议可一次发。
   */
  private async applyMigrationFile(module: string, name: string, sql: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(toPgSql(migrationsInsertSql(module)), [name]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async appliedMigrations(module: string): Promise<string[]> {
    const table = migrationsTableFor(module);
    if (!(await this.tableExists(table))) return [];
    const { results } = await this.exec.prepare(migrationsListSql(module)).bind().all<{ name: unknown }>();
    return results.map((r) => String(r.name));
  }

  async markMigrationApplied(module: string, name: string): Promise<void> {
    // 与 applyMigrations 同一张表（#255）：非 SQL 事件（DO 迁移 tag）不另造记账
    await this.exec.prepare(migrationsCreateSql(module)).bind().run();
    await this.exec.prepare(migrationsInsertIgnoreSql(module)).bind(name).run();
  }

  private async tableExists(table: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
      [table],
    );
    return result.rows.length > 0;
  }
}

/** manifest 形状未收紧时（unknown）的 version 兜底读取。 */
function readVersion(manifest: unknown): string {
  if (manifest && typeof manifest === 'object' && 'version' in manifest) {
    const v = (manifest as Record<string, unknown>).version;
    if (typeof v === 'string' && v) return v;
  }
  return '0.0.0';
}
