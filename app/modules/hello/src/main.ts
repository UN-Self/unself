// SPDX-License-Identifier: AGPL-3.0-only
/**
 * hello node 入口（#110 模块「样子」）：模块作者只写这一层——业务 app + 三行接入。
 * 通用机器（HTTP 宿主、dial-home、env 契约）全在 @unself/sdk/host，此处零协议代码。
 *
 * 通用机器只认进程 env（不读 .env 文件）：
 * - UNSELF_CORE_URL / UNSELF_MODULE_KEY 齐备 → 起本地 HTTP + 反连 core
 * - 缺任一 → 只跑本地 HTTP（不拨号，零依赖自检）
 * 文件加载交给调用方：dev 用 `tsx --env-file=.env`，docker 用 compose env_file。
 */
import app from './index.js';

import { startDialHome } from '@unself/sdk/host';

const handle = startDialHome({ handler: (request) => app.fetch(request, {}, {} as ExecutionContext) });
const addr = handle.addr();
console.log(`hello 模块已就绪：${addr ? `http://${addr}/` : '（监听中）'}`);
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
