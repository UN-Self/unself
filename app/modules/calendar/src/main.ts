// SPDX-License-Identifier: AGPL-3.0-only
/** Calendar Node/Docker 入口：模块业务不变，通用 HTTP 宿主与反连由 @unself/sdk/host 提供。 */
import app from './index.js';
import { loadModuleManifest } from './manifest.js';

import { startDialHome, type StartDialHomeOptions } from '@unself/sdk/host';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const manifest = await loadModuleManifest();
if (!manifest) {
  throw new Error('calendar 模块清单缺失：发行包应包含 dist/manifest.json');
}
const options = {
  handler: (request: Request) => app.fetch(request, {}, {} as ExecutionContext),
  manifest,
  sdkAssetBase: pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'sdk') + '/'),
} as StartDialHomeOptions;

const handle = startDialHome(options);
const addr = handle.addr();
console.log(
  `calendar 模块已就绪：${addr ? `http://${addr}/` : '（监听中）'}` +
    (manifest ? `（manifest v${manifest.version}）` : '（无 manifest，不自报）'),
);

if (process.env.UNSELF_CORE_URL && process.env.UNSELF_MODULE_KEY) {
  console.log(`已开始反连 ${process.env.UNSELF_CORE_URL}（凭 key 哈希握手，core 侧定位模块）`);
} else {
  console.log('未配置 UNSELF_CORE_URL / UNSELF_MODULE_KEY：只跑本地 HTTP，不拨号');
}

const shutdown = () => {
  handle.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
