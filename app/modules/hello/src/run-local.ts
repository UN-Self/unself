// SPDX-License-Identifier: AGPL-3.0-only
/**
 * hello 自托管运行入口（issue #349 反连活样本）：Node 起一个普通 HTTP 服务，可选反连 core。
 *
 * 存在意义：证明模块可以**不在 core 同一台机器、没有公网入口**也能接入——它在 NAT 后
 * 跑起来，靠 dial-home 主动连 core（决策 #108）。这就是「反连」与 installer 装配的差别：
 * 装配要 core 能到模块，反连只要模块能到 core。
 *
 * env：
 * - UNSELF_MODULE_ADDR  本地监听地址（默认 127.0.0.1:8790）
 * - UNSELF_CORE_URL     core 可达地址（有它 + KEY 才反连；缺省 = 只跑本地 HTTP，零回归）
 * - UNSELF_MODULE_KEY   浏览器生成的模块凭据（决策 #108：壳只存它的哈希）
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import app, { type Bindings } from './index.js';
import { startDialHome } from './dial-home.js';

const addr = process.env.UNSELF_MODULE_ADDR ?? '127.0.0.1:8790';
const [host, portText] = addr.includes(':') ? addr.split(/:(?=[^:]*$)/) : ['127.0.0.1', addr];

/**
 * 本地运行体的 Bindings：core 侧能力（CORE_API / JWKS）留空——自托管样本走反连形态，
 * 存储落点由用户在模块侧自行决定（决策 #103③ external 才出连接串）。这里只证明
 * 「隧道通了、页面出得来、HTTP 语义对」这一层。
 */
const bindings = {} as Bindings;

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://${req.headers.host ?? addr}${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers: req.headers as Record<string, string>,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  const response = await app.fetch(request, bindings, {} as ExecutionContext);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(Number(portText), host as string, () => {
  const { port } = server.address() as AddressInfo;
  console.log(`hello 模块已就绪：http://${host}:${port}/`);
});

const coreUrl = process.env.UNSELF_CORE_URL;
const moduleKey = process.env.UNSELF_MODULE_KEY;
if (coreUrl && moduleKey) {
  const handle = startDialHome({
    coreUrl,
    moduleKey,
    handler: (request) => app.fetch(request, bindings, {} as ExecutionContext),
  });
  console.log(`已开始反连 ${coreUrl}（凭 key 哈希握手，core 侧定位模块）`);
  const shutdown = () => {
    handle.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
