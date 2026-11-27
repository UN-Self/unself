// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块侧的 sqlite D1 绑定（#382 轨道 D 第二步）。
 *
 * 模块代码写的是 D1：`env.DB.prepare(sql).bind(...).first()/all()/run()` 加一个
 * `batch()`。CF 部署由平台给真 D1；自部署时这份替身把同一个形状坐到 `node:sqlite` 上，
 * 模块的 SQL 与调用点一行不改。
 *
 * 为什么 sqlite 不需要方言改写：模块自己的 SQL 本来就是 SQLite 方言
 * （`OR IGNORE` / `json_each` / `json_object` / `AUTOINCREMENT`）。自部署默认落 sqlite
 * 文件，这些写法天然成立；要换 PostgreSQL 才需要改写，那是另一件事。
 *
 * `batch()` 的语义按 D1 对齐：**隐式事务**（要么全成要么全败）。所以语句要能重放——
 * 记住「SQL + 参数」，在 BEGIN…COMMIT 之间一口气跑完。`node:sqlite` 是同步 API，
 * 事务里不能有 await（await 会让出微任务，别的请求的语句挤进同一事务）。
 *
 * 迁移记账按模块独立成表（`<module>_migrations`）：多个模块共用一个库时，同名的
 * `0001_baseline.sql` 不能互相顶掉。逐文件执行、整份成功才记账——D1 没有 BEGIN，
 * 迁移链本来就按「单条语句幂等」纪律写（`CREATE IF NOT EXISTS` / `OR IGNORE`）。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** D1 的 `meta`（这里只填模块真正会读的几项）。 */
export interface SqliteD1Meta {
  changes: number;
  last_row_id: number;
  duration: number;
}

export interface SqliteD1Result<T = Record<string, unknown>> {
  success: true;
  results: T[];
  meta: SqliteD1Meta;
}

export interface SqliteD1RunResult {
  success: true;
  meta: SqliteD1Meta;
}

export interface SqliteD1PreparedStatement {
  bind(...values: unknown[]): SqliteD1PreparedStatement;
  /** 无列名 = 整行（无行回 null）；给列名 = 该列的值（D1 同形）。 */
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqliteD1Result<T>>;
  run(): Promise<SqliteD1RunResult>;
}

export interface SqliteD1Database {
  prepare(sql: string): SqliteD1PreparedStatement;
  batch(statements: readonly SqliteD1PreparedStatement[]): Promise<Array<SqliteD1Result | SqliteD1RunResult>>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
}

export interface SqliteD1Options {
  /** 库文件路径；`:memory:` = 进程内临时库（测试/自检用）。 */
  path: string;
}

export interface SqliteD1 {
  /** D1 形状的绑定，直接坐进 `env.DB`。 */
  db: SqliteD1Database;
  /** 底层驱动（迁移/自检需要绕过 D1 形状时用）。 */
  raw: DatabaseSync;
  path: string;
  close(): void;
}

/** `node:sqlite` 的行是 null 原型对象，跨实现形状一致要转成普通对象。 */
function plainRow(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row };
}

/** 内部重放面：batch 要能拿回「SQL + 参数」。 */
interface Replayable {
  readonly sql: string;
  readonly params: readonly unknown[];
}

class SqliteD1Statement implements SqliteD1PreparedStatement, Replayable {
  constructor(
    private readonly driver: DatabaseSync,
    readonly sql: string,
    readonly params: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteD1PreparedStatement {
    return new SqliteD1Statement(this.driver, this.sql, values);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.driver.prepare(this.sql).get(...(this.params as never[]));
    if (row === undefined || row === null) return null;
    const plain = plainRow(row as Record<string, unknown>);
    if (column !== undefined) return (plain[column] ?? null) as T | null;
    return plain as T;
  }

  async all<T = Record<string, unknown>>(): Promise<SqliteD1Result<T>> {
    const started = Date.now();
    const rows = this.driver.prepare(this.sql).all(...(this.params as never[]));
    return {
      success: true,
      results: rows.map((row) => plainRow(row as Record<string, unknown>) as T),
      meta: { changes: 0, last_row_id: 0, duration: Date.now() - started },
    };
  }

  async run(): Promise<SqliteD1RunResult> {
    return this.runSync();
  }

  /** 同步执行（事务内重放专用：BEGIN…COMMIT 之间不允许 await）。 */
  runSync(): SqliteD1RunResult {
    const started = Date.now();
    const info = this.driver.prepare(this.sql).run(...(this.params as never[]));
    return {
      success: true,
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
        duration: Date.now() - started,
      },
    };
  }
}

/**
 * 打开一个 sqlite 库，返回 D1 形状的绑定。同步驱动 + 同步事务：
 * `batch()` 在 BEGIN…COMMIT 之间一口气跑完，不留 await 缝隙。
 */
export function createSqliteD1(options: SqliteD1Options): SqliteD1 {
  const driver = new DatabaseSync(options.path);
  // 模块库与 core 库是两份文件，但 WAL 对「读多写少 + 定时 GC」同样有益。
  driver.exec('PRAGMA journal_mode = WAL');
  driver.exec('PRAGMA foreign_keys = ON');
  driver.exec('PRAGMA busy_timeout = 5000');

  const db: SqliteD1Database = {
    prepare: (sql: string) => new SqliteD1Statement(driver, sql),

    batch(statements) {
      // 事务必须把语句发到同一连接：同步驱动上就是同一句柄，顺序跑完才算原子。
      driver.exec('BEGIN');
      try {
        const out = statements.map((statement) => {
          const replayable = statement as unknown as Replayable;
          return new SqliteD1Statement(driver, replayable.sql, replayable.params).runSync();
        });
        driver.exec('COMMIT');
        return Promise.resolve(out);
      } catch (error) {
        driver.exec('ROLLBACK');
        throw error;
      }
    },

    async exec(sql: string) {
      const started = Date.now();
      driver.exec(sql);
      return { count: 1, duration: Date.now() - started };
    },
  };

  return { db, raw: driver, path: options.path, close: () => driver.close() };
}

export interface ModuleMigrationFile {
  name: string;
  sql: string;
}

/** 读迁移目录：按文件名排序（序号前缀即顺序），只取 `.sql`。 */
export async function readModuleMigrations(dir: string): Promise<ModuleMigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })),
  );
}

export interface ModuleMigrationReport {
  applied: string[];
  skipped: string[];
}

/** 记账表名：模块名进 SQL 前先白名单校验（不接受任意字符串拼标识符）。 */
function migrationsTable(module: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(module)) {
    throw new Error(`模块名不合法（只允许小写字母/数字/下划线，且字母开头）：${module}`);
  }
  return `${module}_migrations`;
}

/**
 * 按文件名记账跑迁移。整份文件成功才记账——失败停下，重跑只补没记上的那几份。
 * **不包事务**：D1 没有 BEGIN，迁移链按「单条语句幂等」写，包事务反而与 CF 行为不一致。
 */
export async function applyModuleMigrations(
  db: SqliteD1Database,
  module: string,
  files: readonly ModuleMigrationFile[],
): Promise<ModuleMigrationReport> {
  const table = migrationsTable(module);
  await db.exec(`CREATE TABLE IF NOT EXISTS ${table} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  const { results } = await db.prepare(`SELECT name FROM ${table}`).all<{ name: string }>();
  const applied = new Set(results.map((row) => String(row.name)));

  const report: ModuleMigrationReport = { applied: [], skipped: [] };
  for (const file of files) {
    if (applied.has(file.name)) {
      report.skipped.push(file.name);
      continue;
    }
    await db.exec(file.sql);
    await db.prepare(`INSERT OR IGNORE INTO ${table}(name) VALUES(?)`).bind(file.name).run();
    report.applied.push(file.name);
  }
  return report;
}
