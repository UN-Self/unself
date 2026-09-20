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
 * **单一真源**：浏览器侧资产只在**本脚本**构建一次；安装器装配（app/installer 与
 * 装配引擎 app/installer/src/engine 的 assemble）只从 `dist/` 复制，绝不再从源码构建（A5 同字节）。
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
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

  // 3.5 发布面不变量（决策 #78 ① / issue #283 A1+A4）：产物里**不得**残留对 `@unself/contracts`
  // 的模块引用——第三方只需装 `@unself/sdk` 一个包，契约内容必须已内联（类型侧由 contract-types.ts 保证）。
  // 放在构建里当硬闸：一旦有人把契约包标成 external，构建当场失败，而不是等发版后第三方装不上。
  const CONTRACTS_IMPORT = /(?:from|import|require\()\s*['"]@unself\/contracts(?:\/[^'"]*)?['"]/;
  const emitted = (await readdir(DIST)).filter((f) => /\.(?:js|d\.ts|ts)$/.test(f));
  for (const rel of emitted) {
    const text = await readFile(join(DIST, rel), 'utf8');
    if (CONTRACTS_IMPORT.test(text)) {
      throw new Error(
        `产物 ${rel} 残留对 @unself/contracts 的引用（应已内联）：第三方只需装 @unself/sdk 一个包；` +
          `请检查 esbuild external 与 contract-types.ts 是否漏了导出`,
      );
    }
  }

  // 4. 许可证随包（AGPL 交付要求；dist 内随 files 发布）。
  for (const name of ['LICENSE', 'NOTICE']) {
    const from = join(ROOT, name);
    if (existsSync(from)) await cp(from, join(DIST, name));
  }

  console.log('▣ @unself/sdk 产物就绪：dist/');
}

await main();
