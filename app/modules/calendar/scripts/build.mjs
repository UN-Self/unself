// SPDX-License-Identifier: AGPL-3.0-only
/** 打包 src 成 dist/worker.js，并校验 manifest 生成 dist/manifest.json。 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SPDX_BANNER = '// SPDX-License-Identifier: AGPL-3.0-only';
const HERE = fileURLToPath(new URL('..', import.meta.url));

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

console.log('▣ calendar 产物就绪：dist/worker.js（CF 装配入口）');

const require2 = createRequire(import.meta.url);
// 用 node 直接跑 tsx 的 cli：Windows 上 execFileSync 执行 .mjs 会走可执行文件查找并报 spawn ENOENT
execFileSync(
  process.execPath,
  [
    require2.resolve('tsx/cli'),
    '--eval',
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { ModuleManifestSchema, manifestFromYamlText } from '@unself/contracts';",
      "const manifest = ModuleManifestSchema.parse(manifestFromYamlText(readFileSync('manifest.yaml', 'utf8')));",
      "writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\\n');",
      "console.log('▣ dist/manifest.json 就绪（manifest.yaml 副本，schema 已校验）');",
    ].join('\n'),
  ],
  { cwd: HERE, stdio: 'inherit' },
);
