// SPDX-License-Identifier: AGPL-3.0-only

/**
 * module-sdk 共享测试工厂：真 SQLite（node:sqlite，Node≥22 内置，零新依赖）
 * 加载 modules 统一迁移 `modules/hello/migrations/hello/*.sql` 真建表（module_kv）
 * + 最小 D1 适配器。与 services/core-api/test/test-factory.ts 同范式但各自独立小工厂
 * （core-api 与 module-sdk 不互相 import，避免包间耦合）。
 *
 * 为什么不用手搓假 D1（审核 T8 / #60）：假替身只按字符串 includes 解释
 * createD1Storage 发出的固定 SQL 形态——源码 SQL 漏 WHERE module_id 过滤、
 * LIKE/ESCAPE 语义写偏、引用幻影列都能全绿。真 SQLite 加载真迁移后：
 * SQL 漏过滤 → 跨模块行当场串味（守护用例）；查询列与建表列错位 → 当场抛错。
 *
 * 适配器对齐真 D1 语义（@cloudflare/workers-types 的 D1PreparedStatement 子集）：
 * - `prepare(sql).bind(...).first()/all()/run()` 链式；
 * - `all()` 回 `{ results, success, meta }`，`run()` 回 `meta.changes`/`meta.last_row_id`；
 * - `first()` 无行回 null，支持 `first('col')` 取单列；
 * - 行是普通对象（node:sqlite 返回 null 原型，D1 返回普通对象）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { D1MinimalDatabase } from '../src/storage';

/** node:sqlite 的 null 原型行 → 普通对象（与真 D1 返回形状一致）。 */
function plainRow<T>(row: Record<string, unknown>): T {
  return { ...row } as T;
}

/** D1 run/exec 的 meta 形状（workers-types D1Meta 的完整字段集）。 */
interface D1Meta {
  duration: number;
  size_after: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changed_db: boolean;
  changes: number;
}

/** D1 执行结果形状（适配器/SDK 双面用）。 */
interface D1Result<T> {
  results: T[];
  success: boolean;
  meta: D1Meta & Record<string, unknown>;
}

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

  bind(...values: unknown[]): this {
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

/** 把 node:sqlite 连接包成 D1MinimalDatabase（SDK 的最小结构面）。 */
export function createD1Adapter(sqlite: DatabaseSync): D1MinimalDatabase {
  return {
    prepare: (sql: string) => new SqliteD1Statement(sqlite, sql),
  } satisfies D1MinimalDatabase;
}

/**
 * 按文件名顺序执行目录下全部 *.sql 迁移（真建表）。返回已应用文件名。
 * module_kv 的真 schema 来自 modules/hello/migrations/hello/0001_module_kv.sql——
 * SDK 的模块存储基础设施表全模块共享，schema 真值唯一，测试不得另抄一份。
 */
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
export interface ModuleTestDb {
  /** 传给 `createD1Storage({ db, ... })` 的 MODULES_DB 绑定。 */
  d1: D1MinimalDatabase;
  /** 直查真库（断言真实行，不经适配器）。 */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** 直查单行。 */
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | null;
  /** 直接执行（种子数据 / 建自定义表等）。 */
  run(sql: string, ...params: unknown[]): { changes: number };
  /** 建表列名（守护用例：查询列 ↔ 建表列错位即红）。 */
  columns(table: string): string[];
  /** 底层句柄（高级用例用）。 */
  sqlite: DatabaseSync;
  close(): void;
}

/**
 * 建一个加载真实 module_kv 迁移的内存库。
 * 每个用例各自 `createModuleDb()`，互不共享状态（并发/顺序都不串味）。
 */
export function createModuleDb(): ModuleTestDb {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(
    sqlite,
    fileURLToPath(new URL('../../../modules/hello/migrations/hello/', import.meta.url)),
  );
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
