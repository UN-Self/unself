// SPDX-License-Identifier: AGPL-3.0-only
/** Calendar 发布产物：Node 宿主入口、Worker 入口和 manifest 快照。
 * SDK 浏览器资产不拷进包（契约 §8「SDK 只有一种用法」）：node 宿主态由 @unself/sdk/host
 * 自供（serveSdkAssetsFrom 定位包内产物），CF 部署态由装配资产拦截——模块不自带副本。 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const SPDX_BANNER = '// SPDX-License-Identifier: AGPL-3.0-only';
const HERE = fileURLToPath(new URL('..', import.meta.url));

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

const require = createRequire(import.meta.url);
execFileSync(
  process.execPath,
  [
    require.resolve('tsx/cli'),
    '--eval',
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { ModuleManifestSchema, manifestFromYamlText } from '@unself/contracts';",
      "const manifest = ModuleManifestSchema.parse(manifestFromYamlText(readFileSync('manifest.yaml', 'utf8')));",
      "writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\\n');",
    ].join('\n'),
  ],
  { cwd: HERE, stdio: 'inherit' },
);

console.log('▣ calendar 产物就绪：dist/main.js、dist/worker.js、dist/manifest.json');
