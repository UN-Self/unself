// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node HTTP 运行器（#360）：把 Node 的 http server 接到与 Worker 相同的请求链路
 * （`handleProdRequest`），并把 WebSocket upgrade 交给隧道运行时。
 *
 * 只做传输层搬运：Node IncomingMessage → Web Fetch `Request`；Fetch `Response` → Node 响应。
 * 业务与静态资产/安全头逻辑都在 `prod-handler` / `assets-fetcher`，这里不写第二份。
 */
import { STATUS_CODES, createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ExecutionContext } from 'hono';

import { handleProdRequest, type ProdEnv, type WorkbenchApp } from '../prod-handler';
import type { TunnelRuntime } from './tunnel-runtime';

/** Hono 只用到这两个方法；Node 进程没有 waitUntil 队列。 */
const executionContext: ExecutionContext = {
  waitUntil(): void {},
  passThroughOnException(): void {},
  props: {},
};

/** 逐跳头不重建（RFC 7230；Node 会按实际连接重新生成）。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/**
 * 请求的真实协议：直连 TLS（socket 加密）优先，其次看反代终结 TLS 的标准头
 * `X-Forwarded-Proto`（取首跳，与 `session.ts` 的 requestIsSecure 同规则）。
 * 不加这段，反代后面所有由 origin 派生的东西（OIDC redirect_uri、邀请链接、头像 URL、
 * CSP selfOrigin）都会拼成 http——https 反代下 SSO 回跳不匹配、页面混内容。
 */
function requestProto(request: IncomingMessage): 'http' | 'https' {
  // net.Socket 的类型没有 encrypted（TLSSocket 才有），直连 TLS 时它在那里是 true
  if ((request.socket as { encrypted?: boolean }).encrypted) return 'https';
  const forwarded = request.headers['x-forwarded-proto'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim().toLowerCase();
  return first === 'https' ? 'https' : 'http';
}

function readBody(request: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    request.on('error', reject);
  });
}

/** Node 请求 → Fetch Request（upgrade 请求不读 body，头保留 upgrade）。 */
async function toFetchRequest(request: IncomingMessage, keepUpgradeHeaders = false): Promise<Request> {
  const host = request.headers.host ?? 'localhost';
  const url = new URL(request.url ?? '/', `${requestProto(request)}://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) && !(keepUpgradeHeaders && (name === 'upgrade' || name === 'connection'))) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = request.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request);
  return new Request(url, { method, headers, body });
}

async function writeFetchResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  target.statusMessage = response.statusText || STATUS_CODES[response.status] || '';
  response.headers.forEach((value, name) => {
    if (name === 'set-cookie') return;
    target.setHeader(name, value);
  });
  const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  if (cookies.length > 0) target.setHeader('set-cookie', cookies);
  const body = new Uint8Array(await response.arrayBuffer());
  target.end(body);
}

export interface HttpServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface StartHttpServerOptions {
  app: WorkbenchApp;
  env: ProdEnv;
  tunnel: TunnelRuntime;
  host: string;
  port: number;
}

/** 起 HTTP 服务；`port=0` 由内核分配（测试用），实际端口从 handle.port 读。 */
export async function startHttpServer(options: StartHttpServerOptions): Promise<HttpServerHandle> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const fetchRequest = await toFetchRequest(request);
        const fetchResponse = await handleProdRequest(options.app, fetchRequest, options.env, executionContext);
        await writeFetchResponse(fetchResponse, response);
      } catch (error) {
        console.error('[node] 请求处理失败', error);
        if (!response.headersSent) response.statusCode = 500;
        response.end('internal error');
      }
    })();
  });

  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      try {
        const fetchRequest = await toFetchRequest(request, true);
        await options.tunnel.handleUpgrade(fetchRequest, request, socket, head, (upgradeRequest) =>
          options.app.fetch(upgradeRequest, options.env, executionContext),
        );
      } catch {
        socket.destroy();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    port,
    url: `http://localhost:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
