// SPDX-License-Identifier: AGPL-3.0-only
/**
 * node:sqlite → D1 形状执行器（#358 T1）：让同一份仓储 SQL 与迁移在 Node 进程里跑。
 *
 * 业务代码只认 D1 形状（`prepare().bind().first()/all()/run()` + 迁移用的 `exec`），
 * 本文件是 node 入口的唯一适配点；worker 入口直接传 `c.env.DB`，不走这里。
 * 形状与 test/d1-memory.ts 同源：行转成普通对象，与真 D1 返回一致。
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { D1Executable, D1ResultLike, D1StatementLike } from './d1';

/** node:sqlite 的 null 原型行 → 普通对象。 */
function plainRow<T>(row: Record<string, unknown>): T {
  return { ...row } as T;
}

class SqliteD1Statement implements D1StatementLike {
  private params: SQLInputValue[] = [];

  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): D1StatementLike {
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

/** 把 node:sqlite 连接包成 D1 形状执行器。 */
export function createSqliteExecutor(sqlite: DatabaseSync): D1Executable {
  return {
    prepare: (sql: string) => new SqliteD1Statement(sqlite, sql),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}
