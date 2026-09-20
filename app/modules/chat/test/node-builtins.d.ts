// SPDX-License-Identifier: AGPL-3.0-only

/**
 * node 内置模块的最小类型声明（chat 的测试工厂只用到 node:sqlite/fs/url，
 * 与 @types/node 声明合并，独立于 module-sdk 的工厂副本——本包不 import 其他包的 test/）。
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
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
