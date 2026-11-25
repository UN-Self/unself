// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node 运行体打包（#360）：两个入口，同一份 esbuild 配置。
 *
 * - `src/entry.node.ts` → `dist/node/entry.node.cjs`（单文件 CJS；直接 node 跑 = 老形态）
 * - `src/cli.ts`        → `dist/node/cli.cjs`（单文件 CJS + shebang，`bin.workbench` 指向它）
 *
 * 与 Worker 打包（`build-worker.ts`，platform neutral）分开：Node 入口不能进 Worker bundle。
 * `pg`/`ws` 与 workspace 源码打成一体，容器里 `node dist/node/cli.cjs` 直接跑；
 * 只有平台专属/可选原生依赖保持 external（`cloudflare:sockets` 是动态导入，Node 侧按需
 * 触发——SMTP 发信当前仍是 CF 运行面的能力；`bufferutil`/`utf-8-validate`/`pg-native`
 * 是可选加速件，缺了 ws/pg 各自有回退）。
 *
 * 为什么是 CJS 不是 ESM：`pg` 是 CJS 包且内部有循环 require，打成 ESM bundle 会把 `Pool`
 * 的基类在循环里打空（运行时 `Class extends value that is not a constructor`）；CJS bundle
 * 保留 require 语义，才能真正单文件运行。
 *
 * 为什么 cli.cjs 的 `import.meta.url` 指向**同目录的 entry.node.cjs** 而不是自己：
 * `entry.node.ts` 用 `argv[1] === 模块自身` 的 isMain 守卫在「直接跑该文件」时自启动。
 * cli.cjs 静态内置了 entry.node.ts，若 `import.meta.url` 指向 cli.cjs，这个守卫会判真 →
 * 守卫生一次、`workbench start` 再生一次，同一个进程起两个 core。指向同目录的
 * entry.node.cjs 后守卫判假，且 `resolvePackageRoot` 的「向上两级找 migrations/core」
 * 与构建身份 `../build-info.json` 的路径推导完全不变。
 */
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(pkgDir, 'dist', 'node');
const outfile = join(outDir, 'entry.node.cjs');
const cliOutfile = join(outDir, 'cli.cjs');

/** banner 里的 `__unselfModuleUrl`：CJS 下 `import.meta.url` 的替身（define 指向这个变量）。 */
const selfUrl = "const __unselfModuleUrl = require('node:url').pathToFileURL(__filename).href;";
/** cli.cjs 的替身：指向同目录的 entry.node.cjs（理由见文件头注释）。 */
const siblingEntryUrl =
  "const __unselfModuleUrl = require('node:url').pathToFileURL(require('node:path').join(__dirname, 'entry.node.cjs')).href;";

await mkdir(outDir, { recursive: true });
// 清掉上一版格式/实验残留（.mjs）：dist/ 进 files 白名单，残留会跟着进 npm 包与镜像
await rm(join(outDir, 'entry.node.mjs'), { force: true });

const targets = [
  {
    entry: join(pkgDir, 'src', 'entry.node.ts'),
    outfile,
    banner: {
      js: `// SPDX-License-Identifier: AGPL-3.0-only\n${selfUrl}`,
    },
  },
  {
    entry: join(pkgDir, 'src', 'cli.ts'),
    outfile: cliOutfile,
    banner: {
      // shebang 必须是第一行：npm 全局装包后靠它 exec cli.cjs。
      js: `#!/usr/bin/env node\n// SPDX-License-Identifier: AGPL-3.0-only\n${siblingEntryUrl}`,
    },
  },
];

for (const target of targets) {
  await build({
    entryPoints: [target.entry],
    outfile: target.outfile,
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
    banner: target.banner,
    logLevel: 'silent',
    absWorkingDir: pkgDir,
  });
}

// bin 目标必须可执行（npm 会按 bin 补权限，但 tarball/镜像里直接拷 dist 时不靠 npm 兜）。
chmodSync(cliOutfile, 0o755);

// 许可证随包（AGPL 交付要求；与 Worker 产物同一落点语义，但放 Node 目录便于镜像单独拷贝）。
for (const name of ['LICENSE', 'NOTICE']) {
  const src = join(pkgDir, '..', '..', name);
  if (existsSync(src)) await copyFile(src, join(outDir, name));
}

console.log(`✓ workbench node bundle → ${outfile}`);
console.log(`✓ workbench cli bundle → ${cliOutfile}（chmod 0755）`);
