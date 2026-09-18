#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 发布产物入口（build-bin.sh 的 esbuild 入口）：直接引 `src/cli.ts`。
 *
 * 与仓库内开发入口 `bin.ts` 的区别：bin.ts 带 tsx 加载器兜底（裸 node 跑 TS 源码）；
 * 发布产物本来就已经是打包好的 JS，不需要任何 TS 加载器——把 tsx 排除在 bundle 之外，
 * 安装器 tarball 因此可以零运行期依赖（见 docs：引擎与产物全在 dist 内）。
 */
import { run } from '../src/cli';
import { homedir } from 'node:os';

await run({
  argv: process.argv.slice(2),
  env: process.env,
  home: homedir(),
  cwd: process.cwd(),
  log: (line) => console.log(line),
  err: (line) => console.error(line),
  exit: (code) => {
    process.exitCode = code;
  },
});
