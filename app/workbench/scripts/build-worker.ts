// SPDX-License-Identifier: AGPL-3.0-only
/**
 * core Worker 打包：src/entry.prod.ts → dist/worker.js（单文件 ESM）。
 *
 * #303：这条原来在 installer 的构建脚本里（`bundleCoreWorker` + 生成式入口模板）。
 * 搬进包内的收益：入口是普通源文件 → 裸包名（@unself/stalwart-provisioner）可解析，
 * 不再需要临时目录、相对路径换算与 `rootDir` 参数；installer 也不再需要 esbuild 打 core。
 *
 * esbuild 参数（format/platform/conditions/external）与既有产物**逐字保持一致**——
 * 换的是「谁跑这次 build」，不是「打出什么」。
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { writeBuildInfo } from './build-info';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(pkgDir, 'src', 'entry.prod.ts');
const outfile = join(pkgDir, 'dist', 'worker.js');

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  conditions: ['workerd', 'import'],
  external: ['@cloudflare/workers-types', 'cloudflare:sockets', 'cloudflare:email'],
  legalComments: 'inline',
  banner: { js: '// SPDX-License-Identifier: AGPL-3.0-only' },
  logLevel: 'silent',
  // 打包可复现（#269 同口径）：路径注释相对固定的工作目录，不随调用方 cwd 漂移。
  absWorkingDir: pkgDir,
});

// 许可证随包（AGPL 交付要求）：根 LICENSE/NOTICE 拷进 dist/（files 白名单只放 dist 与 migrations）
for (const name of ['LICENSE', 'NOTICE']) {
  const src = join(pkgDir, '..', '..', name);
  if (existsSync(src)) await copyFile(src, join(pkgDir, 'dist', name));
}

// 版本烙印（#287，决策 #80）：后端打包路径同样落 dist/build-info.json（与 vite 前端构建同落点、幂等）。
await writeBuildInfo();

console.log(`✓ workbench worker bundle → ${outfile}`);
