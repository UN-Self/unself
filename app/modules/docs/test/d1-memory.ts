// SPDX-License-Identifier: AGPL-3.0-only
/**
 * docs 模块测试库：真 SQLite（node:sqlite，Node≥22 内置）+ 真迁移建表 + 最小 D1 适配器。
 *
 * 与 app/workbench/test/test-factory.ts 同源口径：不手搓假 D1（`sql.includes(...)` 命中即回
 * 手造行，SQL 引用幻影列、违反 UNIQUE/NOT NULL 都会全绿）；真库加载真迁移后，SQL 与建表列
 * 一旦错位当场抛错。
 *
 * 只实现仓储层用到的面：`prepare().bind().first()/all()/run()`，行是普通对象，
 * 文本时间与 D1 一致（`datetime('now')` → `YYYY-MM-DD HH:MM:SS`）。
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { D1Executable, D1ResultLike } from '../src/d1';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/docs/', import.meta.url));

/** node:sqlite 的 null 原型行 → 普通对象（与真 D1 返回形状一致）。 */
function plainRow<T>(row: Record<string, unknown>): T {
  return { ...row } as T;
}

class SqliteD1Statement {
  private params: SQLInputValue[] = [];

  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    // 边界收口：D1 的 bind 接受任意值，node:sqlite 只认 SQLInputValue；兼容性由调用方保证。
    this.params = values as SQLInputValue[];
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.params);
    return row === undefined ? null : plainRow<T>(row);
  }

  async all<T = unknown>(): Promise<D1ResultLike<T>> {
    const results = this.sqlite
      .prepare(this.sql)
      .all(...this.params)
      .map((row) => plainRow<T>(row));
    return { results, success: true, meta: {} };
  }

  async run(): Promise<D1ResultLike<unknown>> {
    const info = this.sqlite.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(info.changes) } };
  }
}

/** 按文件名顺序执行目录下全部 *.sql（可与 D1 一样重复执行，验证幂等）。 */
export function applyDocsMigrations(sqlite: DatabaseSync): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8'));
  }
  return files;
}

export interface DocsTestDb {
  /** 传给仓储层 / 迁移执行器的 D1 绑定。 */
  d1: D1Executable;
  /** 直查真库（断言真实行，不经适配器）。 */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** 直接执行（种子数据 / 造非成员关系等）。 */
  run(sql: string, ...params: unknown[]): { changes: number };
  /** 建表列名（守护用例：SQL 列 ↔ 建表列错位即红）。 */
  columns(table: string): string[];
  sqlite: DatabaseSync;
  close(): void;
}

/**
 * 建一个内存库。
 * - `migrate: false` → 空库（给迁移执行器测试用）
 * - 默认直接重放迁移文件；`migrateTwice` 再跑一遍验证幂等
 */
export function createDocsDb(options: { migrate?: boolean; migrateTwice?: boolean } = {}): DocsTestDb {
  const sqlite = new DatabaseSync(':memory:');
  if (options.migrate !== false) {
    applyDocsMigrations(sqlite);
    if (options.migrateTwice !== false) {
      applyDocsMigrations(sqlite);
    }
  }
  const d1: D1Executable = {
    prepare: (sql: string) => new SqliteD1Statement(sqlite, sql),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return {
    d1,
    sqlite,
    query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
      return sqlite
        .prepare(sql)
        .all(...(params as SQLInputValue[]))
        .map((row) => plainRow<T>(row));
    },
    run(sql: string, ...params: unknown[]) {
      const info = sqlite.prepare(sql).run(...(params as SQLInputValue[]));
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
