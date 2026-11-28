// SPDX-License-Identifier: AGPL-3.0-only
/**
 * docs 模块对 D1 的最小结构化类型（不锁 @cloudflare/workers-types 版本）。
 * 真实 D1Database / D1PreparedStatement 与本接口结构兼容，可直接传入；
 * 测试侧 node:sqlite 适配器（test/d1-memory.ts）实现的也是这一组形状。
 *
 * 拆成独立文件的原因：仓储层只要 `D1Like`，迁移执行器还要 `exec`；
 * 两者共用一个基类型，避免测试里把 `D1Executable` 传给只认 `D1Like` 的函数时缺 `first`。
 */

export interface D1ResultLike<T> {
  results: T[];
  success?: boolean;
  meta: { changes?: number };
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1ResultLike<T>>;
  run(): Promise<D1ResultLike<unknown>>;
}

export interface D1Like {
  prepare(sql: string): D1StatementLike;
}

/** 迁移执行器额外需要的能力：整段 SQL 交给 SQLite 自己解析（多语句）。 */
export interface D1Executable extends D1Like {
  exec(sql: string): Promise<unknown>;
}
