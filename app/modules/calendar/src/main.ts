// SPDX-License-Identifier: AGPL-3.0-only
/** Calendar Node/Docker 入口：模块业务不变，通用 HTTP 宿主与反连由 @unself/sdk/host 提供。
 * SDK 浏览器资产（页面 import 的 ./sdk/module-sdk.esm.js）由 host 自供（serveSdkAssetsFrom
 * 定位 @unself/sdk 包内产物，先于业务）——模块不自带副本、不指路径（契约 §8「SDK 只有一种用法」）。 */
import app from './index.js';
import { loadModuleManifest } from './manifest.js';

import { startDialHome, type StartDialHomeOptions } from '@unself/sdk/host';

const manifest = await loadModuleManifest();
const options = {
  handler: (request: Request) => app.fetch(request, {}, {} as ExecutionContext),
  manifest,
} as StartDialHomeOptions;
const handle = startDialHome(options);
const addr = handle.addr();
console.log(
  `calendar 模块已就绪：${addr ? `http://${addr}/` : '（监听中）'}${manifest ? `（manifest v${manifest.version}）` : '（无 manifest，不自报）'}`
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
