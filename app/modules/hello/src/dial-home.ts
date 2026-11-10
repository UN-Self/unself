// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 反连客户端（issue #349，决策 #108 反连形态）：模块主动外连 core 完成注册与保活。
 *
 * 为什么模块侧要拨号：模块可以在 NAT 后、无公网入口、不在同一集群——只要它**能连上**
 * core 就行（决策 #108 第一条：拓扑自由，互通即可）。core 侧把 `/m/<id>/*` 的请求经隧道
 * 反向推到这条连接上（TunnelRoom DO / Node 纯 WS），模块只当普通 HTTP 服务应答。
 *
 * 凭证何时产生：**由部署者在管理台生成并预注册**（决策 #108：浏览器生成 key、core 只存
 * 哈希）。模块启动时只拿 env 里的明文 key 去**握手**——没有「模块自我注册」这一步，
 * 那等于绕开部署者的信任动作（管理台待连接行才是安装意图的载体）。
 *
 * 帧协议（与 app/workbench/src/do/TunnelRoom.ts 同源定义，勿在此另造一套语义）：
 * - 入站 `{v:1,type:'request',requestId,method,path,query,headers,body}`
 * - 出站 `{v:1,type:'response',requestId,status,headers,body}`
 * - body 一律 base64（跨语言安全），无体 = null。
 *
 * 凭证纪律（决策 #102/#108）：key 明文只活在模块自己的 env 里，连的只是**哈希**
 * （hex(SHA-256(key))）；core 侧比对 registry.credential_hash。壳永不生成、永不经手明文密钥。
 *
 * 断线语义：任一断开都回到「重新握手」——每次重连都带哈希重新核验（core 不缓存会话）。
 * 指数退避（1s→2s→4s…上限 BACKOFF_MAX_MS），停止后不再重连。
 */

/** 入站请求帧（core → 模块）。 */
export interface TunnelRequestFrame {
  v: 1;
  type: 'request';
  requestId: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string | null;
}

/** 出站响应帧（模块 → core）。 */
export interface TunnelResponseFrame {
  v: 1;
  type: 'response';
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

/** 最小 WebSocket 面（Workers / Node(ws) / 测试替身都满足；只用到这四个成员）。 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  /** 单一签名（message 带事件、close/error 不带）——真 WebSocket 的重载形态可直接赋给它。 */
  addEventListener(type: string, handler: (event?: { data?: unknown }) => void): void;
}

export interface DialHomeOptions {
  /** core 可达地址（如 https://unself.example.com）；末尾斜杠容忍。 */
  coreUrl: string;
  /** 模块凭据明文（只在模块 env；只以哈希形态过网）。 */
  moduleKey: string;
  /** 模块自身的 HTTP 处理函数（hello 的 Hono app.fetch 直接传入——同一套路由，不造第二套）。 */
  handler: (request: Request) => Promise<Response> | Response;
  webSocketImpl?: new (url: string) => WebSocketLike;
  /** 退避等待（测试注入，免真睡）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 退避首档/上限（毫秒）。 */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/** 反连句柄：stop() 之后不再重连（进程退出/测试收尾用）。 */
export interface DialHomeHandle {
  stop(): void;
  /** 当前是否已建立隧道（诊断用）。 */
  isOnline(): boolean;
}

/** 退避首档（毫秒）：core 重启/短断网的常见窗口，1s 起跳足够。 */
const DEFAULT_BACKOFF_BASE_MS = 1_000;
/** 退避上限（毫秒）：再久也别让模块彻底躺平，1 分钟一探。 */
const DEFAULT_BACKOFF_MAX_MS = 60_000;

/**
 * 启动反连（幂等：调用一次，内部自管重连循环）。
 * 返回句柄；调用方负责把 handler 接到模块自己的 HTTP 面上（同一条路由）。
 */
export function startDialHome(options: DialHomeOptions): DialHomeHandle {
  const WebSocketCtor = options.webSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WebSocketLike);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const coreUrl = options.coreUrl.replace(/\/+$/, '');
  const backoffBase = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMax = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;

  let stopped = false;
  let socket: WebSocketLike | null = null;
  let online = false;

  /** key 明文的唯一去处：算成哈希 → 过网。明文不出本函数。 */
  async function keyHash(): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.moduleKey));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** 帧 → 真请求：core 侧已剥 /m/<id> 前缀（#63「模块恒挂根路径」，剥前缀是 core 的活）。 */
  function frameToRequest(frame: TunnelRequestFrame): Request {
    const path = frame.path || '/';
    const query = frame.query ? `?${frame.query}` : '';
    const headers = new Headers(frame.headers ?? {});
    const body =
      frame.body === null || frame.method === 'GET' || frame.method === 'HEAD'
        ? undefined
        : base64ToBytes(frame.body);
    return new Request(`https://module.internal${path}${query}`, {
      method: frame.method,
      headers,
      body,
    });
  }

  async function handleFrame(socketLike: WebSocketLike, raw: string): Promise<void> {
    let frame: TunnelRequestFrame;
    try {
      frame = JSON.parse(raw) as TunnelRequestFrame;
    } catch {
      return; // 坏帧丢弃：不让一条垃圾消息打断隧道
    }
    if (frame?.v !== 1 || frame.type !== 'request' || !frame.requestId) return;
    let response: TunnelResponseFrame;
    try {
      const res = await options.handler(frameToRequest(frame));
      const buffer = await res.arrayBuffer();
      response = {
        v: 1,
        type: 'response',
        requestId: frame.requestId,
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: buffer.byteLength > 0 ? bytesToBase64(new Uint8Array(buffer)) : null,
      };
    } catch {
      response = {
        v: 1,
        type: 'response',
        requestId: frame.requestId,
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: bytesToBase64(new TextEncoder().encode(JSON.stringify({ error: 'module handler failed' }))),
      };
    }
    try {
      socketLike.send(JSON.stringify(response));
    } catch {
      // 发送失败 = 连接已死，close 钩子会接手重连
    }
  }

  /** 一次连接尝试：注册 → 握手 → 保持到断开。任何失败都 reject（外层退避）。 */
  function attempt(hash: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // 模块不报 id：core 凭 keyHash 反查定位（#108 env 契约 = 地址 + key 两项）
      const wsUrl = `${coreUrl.replace(/^http/, 'ws')}/api/modules/connect-ws?keyHash=${hash}`;
      let ws: WebSocketLike;
      try {
        ws = new WebSocketCtor(wsUrl);
      } catch (error) {
        reject(error);
        return;
      }
      socket = ws;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        online = false;
        fn();
      };
      ws.addEventListener('message', (event) => {
        // ready 帧只表示握手成立（core 侧已核哈希）；其余按请求帧处理
        const data = typeof event?.data === 'string' ? event.data : '';
        if (data === '' || data.includes('"type":"ready"')) {
          online = true;
          return;
        }
        void handleFrame(ws, data);
      });
      ws.addEventListener('close', () => {
        if (socket === ws) socket = null;
        settle(resolve);
      });
      ws.addEventListener('error', () => {
        if (socket === ws) socket = null;
        settle(() => reject(new Error('tunnel socket error')));
      });
    });
  }

  async function loop(): Promise<void> {
    let delay = backoffBase;
    while (!stopped) {
      try {
        const hash = await keyHash();
        if (stopped) return;
        await attempt(hash);
        // 正常断开（core 侧关闭）：立刻重试一次，不惩罚
        delay = backoffBase;
      } catch {
        if (stopped) return;
        await sleep(delay);
        delay = Math.min(delay * 2, backoffMax);
      }
    }
  }

  void loop();

  return {
    stop() {
      stopped = true;
      online = false;
      try {
        socket?.close();
      } catch {
        // 关不上也无所谓：stopped 已置位，循环不会再连
      }
      socket = null;
    },
    isOnline: () => online,
  };
}

/** base64 → 字节（帧体统一 base64，跨语言安全）。 */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 字节 → base64（分块，避免大响应体炸调用栈）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
