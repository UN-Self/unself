// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node 运行体打包（#360）：`src/entry.node.ts` → `dist/node/entry.node.cjs`（单文件 CJS）。
 *
 * 与 Worker 打包（`build-worker.ts`，platform neutral）分开：Node 入口不能进 Worker bundle。
 * `pg`/`ws` 与 workspace 源码打成一体，容器里 `node dist/node/entry.node.cjs` 直接跑；
 * 只有平台专属/可选原生依赖保持 external（`cloudflare:sockets` 是动态导入，Node 侧按需
 * 触发——SMTP 发信当前仍是 CF 运行面的能力；`bufferutil`/`utf-8-validate`/`pg-native`
 * 是可选加速件，缺了 ws/pg 各自有回退）。
 *
 * 为什么是 CJS 不是 ESM：`pg` 是 CJS 包且内部有循环 require，打成 ESM bundle 会把 `Pool`
 * 的基类在循环里打空（运行时 `Class extends value that is not a constructor`）；CJS bundle
 * 保留 require 语义，才能真正单文件运行。
 */
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(pkgDir, 'src', 'entry.node.ts');
const outfile = join(pkgDir, 'dist', 'node', 'entry.node.cjs');

await mkdir(dirname(outfile), { recursive: true });
// 清掉上一版格式/实验残留（.mjs）：dist/ 进 files 白名单，残留会跟着进 npm 包与镜像
await rm(join(dirname(outfile), 'entry.node.mjs'), { force: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  // CJS 产物：pg 的 CJS 内部有循环 require，用 ESM 打包会把 Pool 基类变成空对象；
  // Worker 产物仍是独立 ESM，两者互不影响。
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  conditions: ['node'],
  external: ['cloudflare:sockets', 'bufferutil', 'utf-8-validate', 'pg-native'],
  legalComments: 'inline',
  define: { 'import.meta.url': '__unselfModuleUrl' },
  banner: {
    js: "// SPDX-License-Identifier: AGPL-3.0-only\nconst __unselfModuleUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  logLevel: 'silent',
  absWorkingDir: pkgDir,
});

// 许可证随包（AGPL 交付要求；与 Worker 产物同一落点语义，但放 Node 目录便于镜像单独拷贝）。
for (const name of ['LICENSE', 'NOTICE']) {
  const src = join(pkgDir, '..', '..', name);
  if (existsSync(src)) await copyFile(src, join(pkgDir, 'dist', 'node', name));
}

console.log(`✓ workbench node bundle → ${outfile}`);
