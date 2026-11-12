// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块宿主运行时（决策 #110）：反连模块的「通用机器」单点——node HTTP 宿主 + dial-home
 * 反连客户端 + env 契约。模块作者只写业务（Hono app），三行接入：
 *
 *   import { startDialHome } from '@unself/sdk/host'
 *   startDialHome({ handler: app.fetch })
 *
 * env 契约（#108 两项，缺一不拨号；ADDR 可选）：
 * - UNSELF_CORE_URL    core 可达地址（域名 / 局域网 IP / Tailscale IP 均可，模块能连到即可）
 * - UNSELF_MODULE_KEY  浏览器生成的模块凭据明文（只在模块 env；core 只存哈希）
 * - UNSELF_MODULE_ADDR 可选，本地 HTTP 监听地址（默认 127.0.0.1:8790）
 *
 * 契约纪律：本模块**只认进程 env，不读任何 .env 文件**——文件加载是调用方（`tsx
 * --env-file`、docker env_file、systemd EnvironmentFile）的事，kit 保持干净边界。
 *
 * 帧协议（与 core 侧 do/TunnelRoom 同源语义，勿在此另造）：
 * - 入站 `{v:1,type:'request',requestId,method,path,query,headers,body}`
 * - 出站 `{v:1,type:'response',requestId,status,headers,body}`；body 一律 base64，无体 = null。
 *   core 侧已剥 `/m/<id>/` 前缀（#63「模块恒挂根路径」在隧道形态的落点），帧路径即根挂载路径。
 *
 * SDK 浏览器资产（/sdk/module-sdk.esm.js 等）：host 自供、先于模块业务——对齐部署态
 * 「静态资产先于 worker」优先级（assemble 拷 assets/sdk/，CF 资产机制拦截）。查找用
 * import.meta.resolve 定位 @unself/sdk 包内产物（工作区符号链接 / tarball 安装都成立），
 * 模块包里没有这份文件（main.js 全内联，兄弟目录是模块自己的 dist）。
 *
 * 凭证纪律（#165/#108）：key 明文只活在模块 env，过网只有 hex(SHA-256(key))；
 * core 按 credential_hash 反查定位模块（模块不报 id）。
 *
 * 断线语义：任一断开都回到「重新握手」，每次重连重新核哈希（core 不缓存会话）；
 * 退避只惩罚失败（error）：1s→2s→4s…上限 60s；干净断开（close）立即重试不惩罚。
 * stop() 后不再重连。
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

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

/** 反连客户端对底层 WS 的最小要求（node 原生 WebSocket 即满足；测试可注入替身）。 */
export interface WebSocketLike {
  close(): void;
  /** 单一签名（message 带事件、close/error 不带）——真 WebSocket 的重载形态可直接赋给它。 */
  addEventListener(type: string, handler: (event?: { data?: unknown }) => void): void;
  /** 发送出站帧（JSON 字符串）。 */
  send(data: string): void;
}

export interface StartDialHomeOptions {
  /** 模块自身的 HTTP 处理函数（Hono app.fetch 直接传入——同一套路由，不造第二套）。 */
  handler: (request: Request) => Promise<Response> | Response;
  /** core 可达地址；默认读 `UNSELF_CORE_URL`。末尾斜杠容忍。 */
  coreUrl?: string;
  /** 模块凭据明文；默认读 `UNSELF_MODULE_KEY`。 */
  moduleKey?: string;
  /** 本地 HTTP 监听地址（`host:port`）；默认读 `UNSELF_MODULE_ADDR`，再缺省 127.0.0.1:8790。 */
  moduleAddr?: string;
  /**
   * 模块连接清单（issue #349 U8：模块可配置选项）。模块方传入**已解析好的对象**
   * （sdk 不做 yaml/json 解析——解析是模块的活）。连接建立（ready 帧后）由 sdk POST 到
   * `${coreUrl}/api/modules/connect-manifest?keyHash=<hash>` 自报一次：失败不阻塞隧道
   * （catch 后 warn，不重试——下次重连再报）；**缺省 = 零行为**（不发任何 HTTP）。
   */
  manifest?: unknown;
  webSocketImpl?: new (url: string) => WebSocketLike;
  /** 退避等待（测试注入，免真睡）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 自定义 fetch（测试注入用）；缺省用全局 fetch。 */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** SDK 资产目录覆写（测试注入；默认 import.meta.resolve 定位 @unself/sdk 包内产物）。 */
  sdkAssetBase?: URL | null;
  /** 退避首档/上限（毫秒）。 */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface DialHomeHandle {
  /** 停止重连并关掉本地 HTTP 服务；幂等。 */
  stop: () => void;
  /** 当前是否已建立隧道（诊断用）。 */
  isOnline: () => boolean;
  /** 本地 HTTP 服务实际地址（listen 完成后可用）。 */
  addr: () => string | null;
}

/** 退避首档（毫秒）：core 重启/短断网的常见窗口，1s 起跳足够。 */
const DEFAULT_BACKOFF_BASE_MS = 1_000;
/** 退避上限（毫秒）：再久也别让模块彻底躺平，1 分钟一探。 */
const DEFAULT_BACKOFF_MAX_MS = 60_000;

/** host 认领的 SDK 浏览器资产（allowlist：无路径拼接，天然免疫目录穿越）。 */
const SDK_ASSET_TYPES = new Map<string, string>([
  ['module-sdk.esm.js', 'text/javascript; charset=utf-8'],
  ['module-sdk.js', 'text/javascript; charset=utf-8'],
]);

/**
 * SDK 资产供应器：/sdk/<已知名> → 吐 @unself/sdk 包内产物字节；其余不认领（返回 null，
 * 落回模块业务）。base = 资产所在目录；null = 供应器整体停用（定位不到包时优雅降级）。
 * 首读后缓存在内存——资产是构建产物，进程生命周期内不变。
 */
export function serveSdkAssetsFrom(
  base: URL | null,
): (path: string) => Promise<Response | null> {
  const cache = new Map<string, ArrayBuffer>();
  return async (path) => {
    if (!base || !path.startsWith('/sdk/')) return null;
    const name = path.slice('/sdk/'.length);
    const contentType = SDK_ASSET_TYPES.get(name);
    if (!contentType) return null; // allowlist 外（含任何 .. 拼接）一律不认领：名字必须精确等于已知名，无路径拼接
    let bytes = cache.get(name);
    if (!bytes) {
      try {
        const u8 = new Uint8Array(await readFile(new URL(name, base)));
        bytes = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
      } catch {
        return null; // 包里没这份产物（如未构建）：不认领，让模块业务自己接
      }
      cache.set(name, bytes);
    }
    return new Response(bytes, { headers: { 'content-type': contentType } });
  };
}

/** 默认资产目录：@unself/sdk 包内产物（dist/）的真实落点；解析不到返回 null（停用）。 */
function defaultSdkAssetBase(): URL | null {
  try {
    return new URL('./', new URL(import.meta.resolve('@unself/sdk/module-sdk.esm.js')));
  } catch {
    return null;
  }
}

/** 字节 → base64（帧体统一 base64，跨语言安全）。 */
const bytesToBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
/** base64 → 字节。 */
const base64ToBytes = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));

/** key 明文的唯一去处：算成哈希 → 过网。明文不出本文件。 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 起 node 宿主 + 反连客户端，返回停止句柄。本函数不阻塞：宿主 listen 后立即返回，
 * 反连在后台自维持（断线退避重连）。`UNSELF_CORE_URL` 与 `UNSELF_MODULE_KEY` 任一缺失
 * = 只跑本地 HTTP 不拨号（零回归语义：hello 历史上无 core 也能单跑）。
 */
export function startDialHome(options: StartDialHomeOptions): DialHomeHandle {
  const env = process.env;
  const coreUrl = (options.coreUrl ?? env.UNSELF_CORE_URL ?? '').replace(/\/+$/, '');
  const moduleKey = options.moduleKey ?? env.UNSELF_MODULE_KEY ?? '';
  const addrText = options.moduleAddr ?? env.UNSELF_MODULE_ADDR ?? '127.0.0.1:8790';
  const [host, portText] = addrText.includes(':') ? addrText.split(/:(?=[^:]*$)/) : ['127.0.0.1', addrText];
  const WebSocketCtor =
    options.webSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WebSocketLike);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoffBase = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMax = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const sdkAssets = serveSdkAssetsFrom(options.sdkAssetBase ?? defaultSdkAssetBase());
  /** manifest 自报用 fetch（测试注入；缺省全局 fetch）。 */
  const reportFetch: (input: string, init?: RequestInit) => Promise<Response> =
    options.fetchImpl ?? ((input, init) => fetch(input, init));

  /**
   * manifest 自报（#349 U8）：ready 后把模块配置清单 POST 给 core（keyHash 定位模块）。
   * 尽力而为：失败 warn 不阻塞隧道、不重试（下次重连再报）；缺省 manifest = 不发任何 HTTP。
   */
  async function reportManifest(hash: string, manifest: unknown): Promise<void> {
    try {
      const res = await reportFetch(`${coreUrl}/api/modules/connect-manifest?keyHash=${hash}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      if (!res.ok) console.warn(`module-sdk: manifest 上报未成功（HTTP ${res.status}），将在下次重连时再报`);
    } catch (error) {
      console.warn(`module-sdk: manifest 上报失败，将在下次重连时再报：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- 本地 HTTP 宿主：模块业务的路，隧道帧也走同一 handler（同一条路由，不造第二套） ----
  let server: Server | null = null;
  let addrNow: string | null = null;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host ?? addrText}${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
      headers: req.headers as Record<string, string>,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    // SDK 资产先于模块业务（部署态同优先级：静态资产先于 worker）
    const response = (await sdkAssets(new URL(request.url).pathname)) ?? (await options.handler(request));
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(Number(portText), host, () => {
    const { address, port } = server!.address() as AddressInfo;
    addrNow = `${address}:${port}`;
  });

  // ---- 反连客户端：coreUrl+key 齐才拨号 ----
  if (!(coreUrl && moduleKey && WebSocketCtor)) {
    return { stop: () => server?.close(), isOnline: () => false, addr: () => addrNow };
  }

  let stopped = false;
  let socket: WebSocketLike | null = null;
  let online = false;

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
      // SDK 资产先于模块业务（与本地 HTTP 同优先级；core 已剥前缀，帧路径即根路径）
      const asset = await sdkAssets(frame.path || '/');
      const res = asset ?? (await options.handler(frameToRequest(frame)));
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

  /** 一次连接尝试：握手 → 保持到断开。干净断开 resolve、出错 reject（外层区分惩罚）。 */
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
      let reported = false;
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
          // manifest 自报（#349 U8）：ready 即报、每条连接至多一次；不 await（不阻塞帧处理）
          if (options.manifest !== undefined && !reported) {
            reported = true;
            void reportManifest(hash, options.manifest);
          }
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

  void (async () => {
    const hash = await sha256Hex(moduleKey);
    let delay = backoffBase;
    while (!stopped) {
      try {
        await attempt(hash);
        if (stopped) return;
        // 正常断开（core 侧关闭）：立刻重试一次，不惩罚
        delay = backoffBase;
      } catch {
        if (stopped) return;
        await sleep(delay);
        delay = Math.min(delay * 2, backoffMax);
      }
    }
  })();

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
      server?.close();
    },
    isOnline: () => online,
    addr: () => addrNow,
  };
}
