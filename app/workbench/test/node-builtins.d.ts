// SPDX-License-Identifier: AGPL-3.0-only

/**
 * node 内置模块的最小类型声明（本仓库 core-api 是 Workers 目标，
 * tsconfig types 只挂 @cloudflare/workers-types，不引 @types/node——
 * 这里只声明测试工厂用到的三个内置模块，零新依赖）。
 */
declare module 'node:sqlite' {
  /** 预处理语句：参数位置绑定与 all/get/run 三个执行面。 */
  export interface StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module 'node:fs' {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:url' {
  // 与 @types/node 的 node:url 合并时，用结构形状兼容 Workers 的全局 URL（无 [Symbol.dispose]）。
  export function fileURLToPath(url: string | { readonly href: string }): string;
}
