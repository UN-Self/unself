// SPDX-License-Identifier: AGPL-3.0-only
/**
 * hello 发布产物构建（#110/#111 模块「样子」）：一个 npm 包，两种已打包产物——
 *
 * 1. dist/main.js   node 入口（bin `unself-hello`）：main.ts 全量 bundle（deps 全内联，
 *    tarball 安装零运行时依赖），shebang + SPDX，npm -g / docker CMD 直接执行。
 * 2. worker.js      CF 装配入口：src/index.ts 全量 bundle。装配引擎吃**包内 worker.js**
 *    （#58「远端一律已打包」，runtime-install 直接解包上传，包内脚本零执行）。
 *
 * deps 声明里不含私有包（@unself/contracts 是 workspace 内部包、对外不发，#76）——
 * 发布包的 dependencies 必须能从公共 registry 解析，内联产物保证这一点。
 */
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

const SPDX_BANNER = '// SPDX-License-Identifier: AGPL-3.0-only';
const HERE = new URL('..', import.meta.url).pathname;

// ① node bin
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  absWorkingDir: HERE,
  outfile: 'dist/main.js',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node\n' + SPDX_BANNER },
  logLevel: 'warning',
});

// ② CF worker 入口：装配引擎/运行时装配吃**包根 worker.js**（#58 已打包形态的既定路径）。
// 产物落 dist/（git 不收构建产物），prepack 复制到包根随 tarball 发布。
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  absWorkingDir: HERE,
  outfile: 'dist/worker.js',
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  legalComments: 'none',
  banner: { js: SPDX_BANNER },
  logLevel: 'warning',
});

console.log('▣ hello 产物就绪：dist/main.js（bin）+ dist/worker.js（CF 装配入口）');
