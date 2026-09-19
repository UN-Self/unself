// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `@unself/sdk` 可发布产物构建（issue #283）。
 *
 * 一次构建产出四类文件（全部随包发布，`files: ["dist"]`）：
 *   dist/index.js          —— 包入口（ESM，`@unself/contracts` 与 zod 已内联，`jose` 保持 external）
 *   dist/index.d.ts (+链)  —— 类型声明（自包含，不引用 `@unself/contracts`，见 contract-types.ts）
 *   dist/module-sdk.esm.js —— 浏览器侧 ESM 资产（平台注入；自包含，含 jose）
 *   dist/module-sdk.js     —— 浏览器侧 IIFE 资产（历史兼容，全局名 __unselfSDK）
 *
 * **单一真源**：浏览器侧资产只在**本脚本**构建一次；安装器装配（packages/installer 与
 * deploy/cloudflare 的 assemble）只从 `dist/` 复制，绝不再从源码构建（A5 同字节）。
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const ROOT = join(PKG, '..', '..');
const DIST = join(PKG, 'dist');
const ENTRY = join(PKG, 'src', 'index.ts');

/** SPDX 横幅：esbuild 默认会剥掉源码里的 `// SPDX-...`（非 legal comment），显式补回。 */
const SPDX_BANNER = '// SPDX-License-Identifier: AGPL-3.0-only';

/** 全部产物共享的 esbuild 参数（固定 absWorkingDir，保证可复现字节）。 */
const common = {
  entryPoints: [ENTRY],
  bundle: true,
  absWorkingDir: PKG,
  legalComments: 'none',
  banner: { js: SPDX_BANNER },
  logLevel: 'warning',
};

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // 1. 包入口：契约（含 zod）内联，唯一外部运行期依赖 = jose。
  await build({
    ...common,
    outfile: join(DIST, 'index.js'),
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['jose'],
  });

  // 2. 浏览器侧资产：完全自包含（含 jose）——平台注入时不依赖 npm 运行期。
  await build({
    ...common,
    outfile: join(DIST, 'module-sdk.esm.js'),
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
  });
  await build({
    ...common,
    outfile: join(DIST, 'module-sdk.js'),
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    globalName: '__unselfSDK',
  });

  // 3. 类型声明：逐文件 emit（相对引用自包含）；contract-types 保证 d.ts 不泄漏 @unself/contracts。
  const require = createRequire(import.meta.url);
  const tsc = require.resolve('typescript/bin/tsc');
  const res = spawnSync(process.execPath, [tsc, '-p', join(PKG, 'tsconfig.build.json')], {
    cwd: PKG,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    throw new Error(`tsc 声明构建失败（退出码 ${res.status}）`);
  }

  // 4. 许可证随包（AGPL 交付要求；dist 内随 files 发布）。
  for (const name of ['LICENSE', 'NOTICE']) {
    const from = join(ROOT, name);
    if (existsSync(from)) await cp(from, join(DIST, name));
  }

  console.log('▣ @unself/sdk 产物就绪：dist/');
}

await main();
