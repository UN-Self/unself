// SPDX-License-Identifier: AGPL-3.0-only

/**
 * modules/hello 复用 package/module-sdk 的测试工厂（真 SQLite module_kv）。
 * 本文件把 module-sdk/test/node-builtins.d.ts 拉进 hello 的编译程序——
 * 两个工厂对 node:sqlite/fs/url 的最小声明与 @types/node 声明合并后，
 * 跨包 import 的文件（module-sdk/test/test-factory.ts）即可通过 tsc --noEmit。
 */
/// <reference path="../../../packages/module-sdk/test/node-builtins.d.ts" />
