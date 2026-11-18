// SPDX-License-Identifier: AGPL-3.0-only
/** Calendar 发布产物：Node 宿主入口、Worker 入口和 manifest 快照。 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
const sdkDist = join(dirname(require.resolve('@unself/sdk/package.json')), 'dist');
await mkdir(join(HERE, 'dist', 'sdk'), { recursive: true });
await cp(join(sdkDist, 'module-sdk.esm.js'), join(HERE, 'dist', 'sdk', 'module-sdk.esm.js'));
await cp(join(sdkDist, 'module-sdk.js'), join(HERE, 'dist', 'sdk', 'module-sdk.js'));

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
