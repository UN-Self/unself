// SPDX-License-Identifier: AGPL-3.0-only
/**
 * docs 模块构建：两件产物，随 npm 包发布。
 *
 * 1. dist/main.js —— node 入口全量 bundle（deps 全内联，含以文本打进来的迁移 SQL），
 *    安装后零运行时依赖；dev 脚本跑的也是它（tsx 加载不了 .sql 导入）。
 * 2. dist/manifest.json —— manifest.yaml → 契约候选 → schema 校验后的 json 副本。
 *    安装侧只认 json；校验在构建期完成，坏清单打不出包。
 *
 * 运行前提：`core/sdk/dist/` 已存在（@unself/sdk 的 exports 只指向 dist/）。本脚本不负责构建它——
 * 仓库根 `pnpm -r build` 按依赖顺序自动先建 SDK；`dev` 脚本也先建 SDK 再调本脚本；
 * 单独运行请先执行 `pnpm --filter @unself/sdk run build`。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { join } from 'node:path';

import { build } from 'esbuild';

const SPDX_BANNER = '// SPDX-License-Identifier: AGPL-3.0-only';
const HERE = fileURLToPath(new URL('..', import.meta.url));

// SDK 未构建时 esbuild 只会报「找不到 @unself/sdk/host」，不指向真正的原因——这里先拦一道。
if (!existsSync(join(HERE, '..', '..', '..', 'core', 'sdk', 'dist', 'host.js'))) {
  throw new Error(
    '@unself/sdk 尚未构建（core/sdk/dist 不存在）。先执行：pnpm --filter @unself/sdk run build',
  );
}

// ① node bin
await build({
  entryPoints: ['src/node.ts'],
  bundle: true,
  absWorkingDir: HERE,
  outfile: 'dist/main.js',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  // 迁移 SQL 以文本方式进产物（src/migrations.ts 的 import），两边入口共用同一份清单
  loader: { '.sql': 'text' },
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node\n' + SPDX_BANNER },
  logLevel: 'warning',
});

// ② manifest 副本。@unself/contracts 的入口是无扩展名相对导入，node 原生解析不了，
// 经 tsx 加载（Windows 上不能直接 spawn .mjs，须经 node 执行）。
const require2 = createRequire(import.meta.url);
const manifestStep = [
  require2.resolve('tsx/cli'),
  '--eval',
  [
    "import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';",
    "import { ModuleManifestSchema, manifestFromYamlText } from '@unself/contracts';",
    "const manifest = ModuleManifestSchema.parse(manifestFromYamlText(readFileSync('manifest.yaml', 'utf8')));",
    "mkdirSync('dist', { recursive: true });",
    "writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\\n');",
    "console.log('▣ dist/manifest.json 就绪（manifest.yaml 副本，schema 已校验）');",
  ].join('\n'),
];
try {
  execFileSync(process.execPath, manifestStep, { cwd: HERE, stdio: 'inherit' });
} catch (error) {
  // execFileSync 的错误对象不带子进程输出（已走 inherit 打到终端）；只补一句定位再抛。
  console.error('manifest.json 生成失败：见上方 tsx 输出（清单没过 ModuleManifestSchema）');
  throw error;
}

console.log('▣ docs 产物就绪：dist/main.js + dist/manifest.json');
