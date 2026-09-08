// SPDX-License-Identifier: AGPL-3.0-only

/**
 * core-api 共享测试工厂：真 SQLite（node:sqlite，Node≥22 内置，零新依赖）
 * 加载 `migrations/core/*.sql` 真建表 + 最小 D1 适配器。
 *
 * 为什么不是手搓假 D1（审核 T1 / #56）：手搓替身用 `sql.includes(...)` 命中即返回
 * 手造行，没有 schema 概念——源码 SQL 引用幻影列、违反 UNIQUE/NOT NULL、写错方言
 * 都能全绿。真 SQLite 加载真迁移后，SQL 与建表列一旦错位就当场抛错（守护用例）。
 *
 * 适配器对齐真 D1 语义（`@cloudflare/workers-types` 的 D1PreparedStatement 子集）：
 * - `prepare(sql).bind(...).first()/all()/run()` 链式；
 * - `all()` 回 `{ results, success, meta }`，`run()` 回 `meta.changes`/`meta.last_row_id`；
 * - `first()` 无行回 null，支持 `first('col')` 取单列；
 * - 行是普通对象（node:sqlite 返回 null 原型，D1 返回普通对象）；
 * - 文本语义与 D1 一致：`datetime('now')` 落库为 `YYYY-MM-DD HH:MM:SS`。
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** node:sqlite 的 null 原型行 → 普通对象（与真 D1 返回形状一致）。 */
function plainRow<T>(row: Record<string, unknown>): T {
  return { ...row } as T;
}

/** D1 run/exec 的 meta 形状（workers-types D1Meta 的完整字段集）。 */
function d1Meta(changes: number, lastRowId: number): D1Meta & Record<string, unknown> {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  };
}

/** 只读语句判定：真 D1 对 SELECT 的 run() 回 changes=0。 */
const READ_ONLY_SQL = /^\s*(select|with|pragma)\b/i;

/** 单条语句的 D1 适配（bind 后 first/all/run）。 */
class SqliteD1Statement {
  private params: unknown[] = [];

  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.params = values;
    return this;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.params);
    if (row === undefined) {
      return null;
    }
    if (colName !== undefined) {
      return (row[colName] as T) ?? null;
    }
    return plainRow<T>(row);
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.sqlite
      .prepare(this.sql)
      .all(...this.params)
      .map((row) => plainRow<T>(row));
    return { results: rows, success: true, meta: d1Meta(0, 0) };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    if (READ_ONLY_SQL.test(this.sql)) {
      this.sqlite.prepare(this.sql).all(...this.params);
      return { results: [] as T[], success: true, meta: d1Meta(0, 0) };
    }
    const info = this.sqlite.prepare(this.sql).run(...this.params);
    return {
      results: [] as T[],
      success: true,
      meta: d1Meta(Number(info.changes), Number(info.lastInsertRowid)),
    };
  }
}

/** 把 node:sqlite 连接包成 D1Database（只实现测试与源码用到的面）。 */
export function createD1Adapter(sqlite: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new SqliteD1Statement(sqlite, sql),
  } as unknown as D1Database;
}

/** 按文件名顺序执行目录下全部 *.sql 迁移（真建表）。返回已应用文件名。 */
export function applyMigrations(sqlite: DatabaseSync, dir: string): string[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(`${dir}/${file}`, 'utf8'));
  }
  return files;
}

/** 测试库句柄：D1 绑定 + 直查真库的断言通道 + 列名查询（守护用例）。 */
export interface CoreTestDb {
  /** 传给 `app.request(..., env)` 的 CORE_DB 绑定。 */
  d1: D1Database;
  /** 直查真库（断言真实行，不经适配器）。 */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** 直查单行。 */
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | null;
  /** 直接执行（种子数据 / 翻转 setup_done 等）。 */
  run(sql: string, ...params: unknown[]): { changes: number };
  /** 建表列名（守护用例：查询列 ↔ 建表列错位即红）。 */
  columns(table: string): string[];
  /** 底层句柄（高级用例用）。 */
  sqlite: DatabaseSync;
  close(): void;
}

/**
 * 建一个加载全部 core 迁移的内存库。
 * 每个用例各自 `createCoreDb()`，互不共享状态（并发/顺序都不串味）。
 */
export function createCoreDb(): CoreTestDb {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite, fileURLToPath(new URL('../migrations/core/', import.meta.url)));
  const d1 = createD1Adapter(sqlite);
  return {
    d1,
    sqlite,
    query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
      return sqlite
        .prepare(sql)
        .all(...params)
        .map((row) => plainRow<T>(row));
    },
    first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | null {
      const row = sqlite.prepare(sql).get(...params);
      return row === undefined ? null : plainRow<T>(row);
    },
    run(sql: string, ...params: unknown[]) {
      const info = sqlite.prepare(sql).run(...params);
      return { changes: Number(info.changes) };
    },
    columns(table: string): string[] {
      return sqlite
        .prepare('SELECT name FROM pragma_table_info(?)')
        .all(table)
        .map((row) => String((row as { name: unknown }).name));
    },
    close() {
      sqlite.close();
    },
  };
}
