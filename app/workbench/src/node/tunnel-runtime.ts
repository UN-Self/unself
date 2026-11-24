// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 隧道运行时适配层（#360 轨道 D）：把 Node 的 `ws` 服务端接到 `TunnelRoom` 依赖的
 * 四个 Cloudflare 运行面形状上——`WebSocketPair`、`state.acceptWebSocket`、
 * `state.getWebSockets`、`socket.serializeAttachment()/deserializeAttachment()`。
 *
 * TunnelRoom 本体零改动：业务（验签、帧配对、在线表、1008 语义）仍只有一份。
 * 关键接线：
 * - 先用同一个 Hono app 处理 upgrade 请求（凭据核验在 routes/connect.ts），DO 侧
 *   `handleConnect` 在请求期间创建 `WebSocketPair`；`AsyncLocalStorage` 把这个请求
 *   与「尚未绑定的 Node socket 槽」绑定，避免并发 upgrade 串房；
 * - 101 响应回来后（`Response` 的 101+webSocket 形状在 Node 里由本文件的小垫片放行）
 *   才真正 `ws.handleUpgrade`，把 `ws` 绑进槽位并触发 flush（ready 帧先入队，后发送）；
 * - 非 101（凭据不配/未知模块）直接把 app 的 HTTP 响应写回 socket，不建立 WebSocket。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket as WsSocket } from 'ws';

import { TunnelRoom } from '../do/TunnelRoom';

/** TunnelRoom 需要的 DO state 最小面（生产由 CF 提供，Node 侧只有这两个方法）。 */
class NodeDoState {
  private readonly accepted = new Set<NodeTunnelSocket>();

  acceptWebSocket(socket: NodeTunnelSocket): void {
    this.accepted.add(socket);
  }

  getWebSockets(): NodeTunnelSocket[] {
    return [...this.accepted];
  }

  forget(socket: NodeTunnelSocket): void {
    this.accepted.delete(socket);
  }
}

interface PendingUpgrade {
  socket: NodeTunnelSocket | null;
  room: TunnelRoom | null;
  state: NodeDoState | null;
}

/** 每次 upgrade 请求一个槽（AsyncLocalStorage 保证并发请求不串）。 */
const pendingUpgrade = new AsyncLocalStorage<PendingUpgrade>();

function toBytes(data: string | ArrayBuffer | Uint8Array): string | Uint8Array {
  if (typeof data === 'string') return data;
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * workers `WebSocket` 的 Node 替身：`send` 在真 ws 尚未绑定时先入队（TunnelRoom 建连
 * 即发 ready 帧，而 Node 侧要等 app 核验完才 handleUpgrade），绑定后按序 flush。
 */
class NodeTunnelSocket {
  private ws: WsSocket | null = null;
  private queue: Array<string | Uint8Array> = [];
  private attachment: unknown = null;
  private closed = false;

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.closed) return;
    const payload = toBytes(data);
    if (this.ws && this.ws.readyState === 1) this.ws.send(payload);
    else this.queue.push(payload);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch {
        // socket 已死：关闭语义已由 closed 标记承担。
      }
    }
  }

  serializeAttachment(data: unknown): void {
    this.attachment = data;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  bind(ws: WsSocket): void {
    this.ws = ws;
    for (const payload of this.queue) ws.send(payload);
    this.queue = [];
  }
}

/** `new WebSocketPair()` 的 Node 形态：服务端槽从当前 upgrade 上下文取。 */
class NodeWebSocketPair {
  0: unknown;
  1: NodeTunnelSocket;

  constructor() {
    const pending = pendingUpgrade.getStore();
    if (!pending) throw new Error('WebSocketPair 只能在隧道 upgrade 请求内创建');
    const server = new NodeTunnelSocket();
    pending.socket = server;
    this[0] = { __unselfNodeClient: true };
    this[1] = server;
  }
}

let globalsInstalled = false;

/**
 * 安装 Node 侧运行面垫片（进程级，一次）：
 * - `WebSocketPair` 交给隧道适配层；
 * - Node 的 Response 构造器拒绝 101 状态码，这里只对「101 + webSocket」放行，
 *   其余请求原样走真 Response（不改变任何 HTTP 语义）。
 */
export function installTunnelGlobals(): void {
  if (globalsInstalled) return;
  globalsInstalled = true;
  const scope = globalThis as unknown as {
    WebSocketPair: typeof NodeWebSocketPair;
    Response: typeof Response;
  };
  scope.WebSocketPair = NodeWebSocketPair;

  const RealResponse = scope.Response;
  const PatchedResponse = function (body: BodyInit | null, init?: ResponseInit) {
    if (init?.status === 101 && 'webSocket' in init) {
      return {
        status: 101,
        webSocket: (init as { webSocket: unknown }).webSocket,
        headers: new Headers(),
      } as unknown as Response;
    }
    return new RealResponse(body, init);
  } as unknown as typeof Response;
  Object.setPrototypeOf(PatchedResponse, RealResponse);
  scope.Response = PatchedResponse;
}

export interface TunnelRuntime {
  namespace: DurableObjectNamespace;
  /** 处理一个 HTTP upgrade：先走 app（核验），101 后再把真 ws 绑进 DO 槽。 */
  handleUpgrade(
    request: Request,
    incoming: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    appFetch: (request: Request) => Response | Promise<Response>,
  ): Promise<void>;
  close(): Promise<void>;
}

const rawDataToBytes = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data);
};

/** 把 app 的 HTTP 响应写回原始 upgrade socket（未升级成功的分支）。 */
async function writeRawResponse(socket: Duplex, response: Response): Promise<void> {
  const body = new Uint8Array(await response.arrayBuffer());
  const lines: string[] = [`HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ''}`];
  response.headers.forEach((value, key) => lines.push(`${key}: ${value}`));
  lines.push(`content-length: ${body.byteLength}`, 'connection: close', '', '');
  socket.write(lines.join('\r\n'));
  if (body.byteLength > 0) socket.write(body);
  socket.end();
}

/** 创建隧道运行时（一进程一套：Map<moduleId, TunnelRoom>，与 CF DO 一房一模块同构）。 */
export function createTunnelRuntime(db: D1Database): TunnelRuntime {
  installTunnelGlobals();
  const rooms = new Map<string, { room: TunnelRoom; state: NodeDoState }>();
  const wss = new WebSocketServer({ noServer: true });

  const namespace = {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const moduleId = String(id);
      let entry = rooms.get(moduleId);
      if (!entry) {
        const state = new NodeDoState();
        const room = new TunnelRoom(state as unknown as DurableObjectState, { CORE_DB: db });
        entry = { room, state };
        rooms.set(moduleId, entry);
      }
      const pending = pendingUpgrade.getStore();
      if (pending) {
        pending.room = entry.room;
        pending.state = entry.state;
      }
      return { fetch: (request: Request) => entry.room.fetch(request) };
    },
  } as unknown as DurableObjectNamespace;

  return {
    namespace,

    async handleUpgrade(request, incoming, socket, head, appFetch): Promise<void> {
      const pending: PendingUpgrade = { socket: null, room: null, state: null };
      let response: Response;
      try {
        response = await pendingUpgrade.run(pending, () => appFetch(request));
      } catch {
        await writeRawResponse(socket, new Response('upgrade failed', { status: 500 }));
        return;
      }
      if (response.status !== 101) {
        await writeRawResponse(socket, response);
        return;
      }
      const server = pending.socket;
      const room = pending.room;
      const state = pending.state;
      if (!server || !room || !state) {
        await writeRawResponse(socket, new Response('tunnel handshake incomplete', { status: 500 }));
        return;
      }
      wss.handleUpgrade(incoming, socket, head, (ws) => {
        server.bind(ws);
        const asWorkersSocket = server as unknown as WebSocket;
        ws.on('message', (data: RawData) => {
          void room.webSocketMessage(asWorkersSocket, rawDataToBytes(data));
        });
        ws.on('close', () => {
          room.webSocketClose(asWorkersSocket);
          state.forget(server);
        });
        ws.on('error', () => {
          room.webSocketError(asWorkersSocket);
          state.forget(server);
        });
      });
    },

    async close(): Promise<void> {
      for (const { state } of rooms.values()) {
        for (const socket of state.getWebSockets()) socket.close(1001, 'server shutdown');
      }
      rooms.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
