// SPDX-License-Identifier: AGPL-3.0-only

/**
 * node 内置模块的最小类型声明（packages/module-sdk 的 tsconfig 不引 @types/node，
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
  export function fileURLToPath(url: string | URL): string;
}
