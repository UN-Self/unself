// SPDX-License-Identifier: AGPL-3.0-only
/**
 * connect 反连隧道 DO（issue #349，决策 #108）：
 * 模块 dial-home 反连后，core 到模块的反向代理出口住这里。
 *
 * 运行体定位（决策 #106/#108）：DO 是 CF 落点的**过渡事实**而非承诺——Node 运行体
 * 纯 WS（无 DO）；本类只依赖 `state.acceptWebSocket`（hibernation API，省费的关键：
 * 模块长连不占 CPU 时间，只有帧到达才唤醒计费）与 websocket handlers，平台专属面
 * 收敛在这一层，平替时按同名内部路由重写本类即可。
 *
 * 对外面 = stub.fetch 内部路由（DO RPC 不用，类型面与运行体都依赖最小 workers 面）：
 * - GET  https://tunnel.internal/connect?moduleId=&keyHash=  WS upgrade 交接（101 + client）
 * - POST https://tunnel.internal/forward?target=<路径+查询>   数据面转发（回模块 HTTP 响应）
 * - POST https://tunnel.internal/poll?moduleId=&keyHash=&waitMs=  HTTP 兜底长轮询
 * - POST https://tunnel.internal/respond?moduleId=&keyHash=   模块对轮询帧的 HTTP 回答
 * - GET  https://tunnel.internal/status?moduleId=             在线状态（「测试连接」）
 *
 * 参考（只参考模式，不动其代码）：app/modules/chat/worker/src/do/ChannelRoom.js 的
 * DO websocket 模式（acceptWebSocket + serializeAttachment）；#51 验签纪律照搬：
 * 入站先验（upgrade/poll/respond 由路由层核哈希后带参进来，DO 侧再验启停状态）+
 * 已建连按帧重验（每条响应帧回库重查 enabled，哈希不重查——建连已核、换 key = 重连）。
 *
 * 连接池语义（决策 #108：连接形式模块自选，core 备能力不强制）：一房多连 = 广播取
 * 最先响应者（connect 模块默认单实例部署，多连是重连竞态窗口的过渡形态）；
 * 负载均衡/粘滞归后续 issue。
 */
import { verifyConnectCredential } from '../services/connect-registry';

/** serializeAttachment 形状（决策 #51 同纪律：只存已核验的绑定事实，JSON 可序列化）。 */
export interface TunnelAttachment {
  moduleId: string;
  /** 建连时已核验的 keyHash（64 位小写 hex）；断线清表后重连必经 upgrade 重核（测试锁定）。 */
  keyHash: string;
}

/** 隧道请求帧（壳侧 → 模块）。响应按 requestId 配对回帧。 */
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

/** 隧道响应帧（模块 → 壳）。 */
export interface TunnelResponseFrame {
  v: 1;
  type: 'response';
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export type TunnelFrame = TunnelRequestFrame | TunnelResponseFrame;

/** DO 环境绑定（只读；核验走 CORE_DB 定向读，隧道面不写库）。 */
export interface TunnelEnv {
  CORE_DB: D1Database;
}

/** 帧协议版本（请求/响应帧的 v 字段必须 = 1）。 */
export const TUNNEL_PROTOCOL_VERSION = 1 as const;

/** DO 内部路由 host（仅 stub.fetch 可达，外部请求打不进来）。 */
export const TUNNEL_INTERNAL_ORIGIN = 'https://tunnel.internal';

/** 每请求转发超时（毫秒）：模块侧无响应即 504（HTTP 轮询回答可能耗时，给足上限）。 */
const FORWARD_TIMEOUT_MS = 15_000;
/** 长轮询服务端等待上限（毫秒；模块 waitMs 再大也截断，防 DO 挂请求超平台上限）。 */
const MAX_POLL_WAIT_MS = 25_000;
/** 单条隧道帧 body 上限（base64 后约 1.5MB，低于 Workers 帧上限，防单帧打爆内存）。 */
const MAX_FRAME_BODY_BYTES = 1_500_000;
/** 一房最大并发转发（连接池语义未定的过渡上限，防单房打爆）。 */
const MAX_PENDING = 32;
/** 单次 poll 摘取的帧数上限（模块侧按批处理，多帧再来一轮）。 */
const MAX_POLL_BATCH = 16;

/** 附着在挂起转发上的状态：resolve + 超时计时器 + 轮询投递标记。 */
interface PendingEntry {
  frame: TunnelRequestFrame;
  resolve: (frame: TunnelResponseFrame) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  /** false = 还在等投递（WS/poll）；true = 已交到模块手里，只等 response/respond。 */
  delivered: boolean;
}

export class TunnelRoom {
  private state: DurableObjectState;
  private env: TunnelEnv;
  /** 存活连接（hibernation 唤醒后由构造函数从 attachments 重建）。 */
  private connections: Map<WebSocket, TunnelAttachment>;
  /** requestId → 挂起的转发（forward 进、response 帧/respond 出）。 */
  private pending: Map<string, PendingEntry>;
  /** 长轮询等待者（有帧可摘时唤醒）。 */
  private pollWaiters: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }>;

  constructor(state: DurableObjectState, env: TunnelEnv) {
    this.state = state;
    this.env = env;
    this.connections = new Map();
    this.pending = new Map();
    this.pollWaiters = [];

    // hibernation 唤醒：accept 过的 socket 重新挂回内存表（attachment 是建连时的核验事实）。
    for (const socket of this.state.getWebSockets()) {
      const meta = socket.deserializeAttachment() as TunnelAttachment | null;
      if (meta?.moduleId && meta.keyHash) {
        this.connections.set(socket, meta);
      }
    }
  }

  /** 内部路由分发（routes/connect.ts 与数据面 entry.prod.ts 都走这里）。 */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/connect':
        return this.handleConnect(request, url);
      case '/forward':
        return this.handleForward(request, url);
      case '/poll':
        return this.handlePoll(request, url);
      case '/respond':
        return this.handleRespond(request, url);
      case '/status':
        return this.handleStatus(url);
      default:
        return Response.json({ error: 'unknown tunnel route' }, { status: 404 });
    }
  }

  /** WS upgrade 交接：建连核验已由路由层做过（参数只带结果），这里 accept + 绑事实。 */
  private handleConnect(request: Request, url: URL): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ error: 'expected websocket upgrade' }, { status: 400 });
    }
    const moduleId = url.searchParams.get('moduleId') ?? '';
    const keyHash = url.searchParams.get('keyHash') ?? '';
    if (!moduleId || !keyHash) {
      return Response.json({ error: 'missing moduleId/keyHash' }, { status: 400 });
    }
    // WebSocketPair 双槽（workers-types 形状是 {0,1} 对象非元组，ChannelRoom 同款 Object.values 取槽）：
    // [0]=client 回给 upgrade，[1]=server 进 DO。
    const pair = new WebSocketPair() as unknown as { 0: WebSocket; 1: WebSocket };
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ moduleId, keyHash } satisfies TunnelAttachment);
    this.connections.set(server, { moduleId, keyHash });
    server.send(
      JSON.stringify({ v: TUNNEL_PROTOCOL_VERSION, type: 'ready', moduleId }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 数据面转发（壳 /m/<id>/* 入口进）：组请求帧 → WS 在线走 WS，否则进 poll 队列 →
   * 等模块 response 帧 / respond 回答 → 回 HTTP 响应。断线/无连接 503 人话；超时 504。
   */
  private async handleForward(request: Request, url: URL): Promise<Response> {
    const target = url.searchParams.get('target') ?? '';
    const targetUrl = new URL(target, TUNNEL_INTERNAL_ORIGIN);

    const live = [...this.connections.entries()];
    // 离线即 503 人话（任务书定案「路由 503 人话」）：无 WS 连接且无 poll 等待者 = 模块
    // 必不在收帧（poll 兜底的模块在等待期内会挂着 waiter），队列投递无从谈起，不等超时。
    if (live.length === 0 && this.pollWaiters.length === 0) {
      return tunnelDown(
        targetUrl,
        503,
        'connect 模块当前不在线：隧道未建立（模块未 dial-home 或已断开）',
      );
    }
    if (this.pending.size >= MAX_PENDING) {
      return tunnelDown(targetUrl, 503, '隧道并发已达上限，请稍后重试');
    }

    let body: string | null = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const raw = await request.arrayBuffer();
      if (raw.byteLength > MAX_FRAME_BODY_BYTES) {
        return tunnelDown(targetUrl, 413, '请求体超出隧道帧上限');
      }
      body = raw.byteLength > 0 ? arrayBufferToBase64(raw) : null;
    }

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      // 壳内代理面逐跳头不透传（RFC 7230；host/content-length 由模块侧按帧重建）。
      if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
    });

    const frame: TunnelRequestFrame = {
      v: TUNNEL_PROTOCOL_VERSION,
      type: 'request',
      requestId: newTunnelRequestId(),
      method: request.method,
      path: targetUrl.pathname,
      query: targetUrl.search.replace(/^\?/, ''),
      headers,
      body,
    };

    const responseFrame = await this.dispatch(frame, live);
    if (!responseFrame) {
      return live.length === 0
        ? tunnelDown(targetUrl, 503, 'connect 模块未在时限内应答（poll 兜底窗口内无模块来取）')
        : tunnelDown(targetUrl, 504, 'connect 模块未在时限内响应（隧道可能已断开）');
    }
    return this.responseFromFrame(responseFrame);
  }

  /**
   * 投递单帧并等回答：WS 连接广播取最先响应；无 WS 连接进 poll 队列等模块轮询+回答。
   * 超时 reject(null)。返回 resolve 的首条响应帧；全失败回 null。
   */
  private dispatch(
    frame: TunnelRequestFrame,
    live: Array<[WebSocket, TunnelAttachment]>,
  ): Promise<TunnelResponseFrame | null> {
    const timeoutToken = Symbol('forward-timeout');
    const attempts: Array<Promise<TunnelResponseFrame>> = [];
    if (live.length > 0) {
      for (const [socket, meta] of live) {
        attempts.push(this.deliverOverSocket(socket, meta, frame, timeoutToken));
      }
    } else {
      attempts.push(this.deliverOverQueue(frame, timeoutToken));
    }
    return Promise.any(attempts).catch(() => null);
  }

  /** WS 投递：send 请求帧 + 挂 pending；socket 死亡/关闭即 reject（让 Promise.any 取别的）。 */
  private deliverOverSocket(
    socket: WebSocket,
    meta: TunnelAttachment,
    frame: TunnelRequestFrame,
    timeoutToken: symbol,
  ): Promise<TunnelResponseFrame> {
    return new Promise<TunnelResponseFrame>((resolve, reject) => {
      if (!this.connections.has(socket)) {
        reject(new Error('socket not live'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(frame.requestId);
        reject(timeoutToken);
      }, FORWARD_TIMEOUT_MS);
      this.pending.set(frame.requestId, { frame, resolve, reject, timer, delivered: true });
      const outbound = { ...frame, moduleId: meta.moduleId };
      try {
        socket.send(JSON.stringify(outbound));
      } catch (error) {
        this.clearPending(frame.requestId);
        reject(error instanceof Error ? error : new Error('send failed'));
      }
    });
  }

  /** 队列投递（模块走 HTTP 兜底）：帧进队列等 poll 摘取，respond 回答后 resolve。 */
  private deliverOverQueue(frame: TunnelRequestFrame, timeoutToken: symbol): Promise<TunnelResponseFrame> {
    return new Promise<TunnelResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.requestId);
        reject(timeoutToken);
      }, FORWARD_TIMEOUT_MS);
      // delivered=false = 未投递（poll 可摘）；摘走才置 true。
      this.pending.set(frame.requestId, { frame, resolve, reject, timer, delivered: false });
      this.wakePollWaiters();
    });
  }

  /** HTTP 兜底长轮询：摘 delivered=false 的帧；空且带 waitMs 时挂等待（上限截断）。 */
  private async handlePoll(request: Request, url: URL): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'POST only' }, { status: 405 });
    }
    const moduleId = url.searchParams.get('moduleId') ?? '';
    const keyHash = url.searchParams.get('keyHash') ?? '';
    // 轮询与 WS upgrade 同一核验纪律（#51：每次入站都核，不认会话）。
    const gate = await verifyConnectCredential(this.env.CORE_DB, moduleId, keyHash);
    if (!gate.ok) {
      return Response.json({ error: gate.error }, { status: gate.status });
    }
    const waitMs = Math.min(
      Math.max(0, Number(url.searchParams.get('waitMs') ?? 0) || 0),
      MAX_POLL_WAIT_MS,
    );
    const batch = this.takeQueuedFrames(moduleId);
    if (batch.length > 0 || waitMs <= 0) {
      return Response.json({ requests: batch });
    }
    await this.waitPollable(waitMs);
    return Response.json({ requests: this.takeQueuedFrames(moduleId) });
  }

  /** 模块对轮询帧的 HTTP 回答（形状同 WS response 帧，纪律同：核验 + pending 配对）。 */
  private async handleRespond(request: Request, url: URL): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'POST only' }, { status: 405 });
    }
    const moduleId = url.searchParams.get('moduleId') ?? '';
    const keyHash = url.searchParams.get('keyHash') ?? '';
    const gate = await verifyConnectCredential(this.env.CORE_DB, moduleId, keyHash);
    if (!gate.ok) {
      return Response.json({ error: gate.error }, { status: gate.status });
    }
    const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
    const rawStatus = payload?.status;
    const statusOk =
      typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 200 && rawStatus <= 599;
    if (!requestId || !statusOk) {
      return Response.json({ error: 'malformed respond payload' }, { status: 400 });
    }
    const entry = this.pending.get(requestId);
    if (!entry) {
      return Response.json({ error: 'unknown or expired requestId' }, { status: 404 });
    }
    // #51 按帧重验已由上方 gate 承担（respond 每次都核）。
    this.clearPending(requestId);
    entry.resolve({
      v: TUNNEL_PROTOCOL_VERSION,
      type: 'response',
      requestId,
      status: rawStatus as number,
      headers: isHeaderMap(payload?.headers),
      body: typeof payload?.body === 'string' ? payload.body : null,
    });
    return Response.json({ ok: true });
  }

  /** 在线状态（「测试连接」消费）：在线 = 存活 WS 会话 > 0（在线 ≠ enabled，见 connect-registry）。 */
  private handleStatus(url: URL): Response {
    const moduleId = url.searchParams.get('moduleId') ?? '';
    return Response.json({ moduleId, online: this.connections.size > 0 });
  }

  /** 摘取队列帧（FIFO；只摘未投递的，摘走置 delivered）。帧内补 moduleId（模块侧自校验；
   * 队列按房=DO 一房一模块天然隔离，双保险）。 */
  private takeQueuedFrames(moduleId: string): Array<TunnelRequestFrame & { moduleId: string }> {
    const out: Array<TunnelRequestFrame & { moduleId: string }> = [];
    for (const entry of this.pending.values()) {
      if (entry.delivered) continue;
      entry.delivered = true;
      // 帧内带 moduleId（模块侧自校验），队列按房（DO 一房一模块）天然隔离，双保险。
      out.push({ ...entry.frame, moduleId });
      if (out.length >= MAX_POLL_BATCH) break;
    }
    return out;
  }

  /** 挂等待：有帧进队（wakePollWaiters）或 waitMs 到时返回。 */
  private waitPollable(waitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pollWaiters = this.pollWaiters.filter((w) => w.resolve !== notify);
        resolve();
      }, waitMs);
      const notify = () => {
        clearTimeout(timer);
        resolve();
      };
      this.pollWaiters.push({ resolve: notify, timer });
    });
  }

  private wakePollWaiters(): void {
    for (const waiter of this.pollWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  /** 模块 → 壳方向：响应帧配对 resolve；请求帧本期不用（壳→模块单程数据面）。 */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer | Uint8Array): Promise<void> {
    const meta = this.connections.get(ws);
    if (!meta) {
      // 无绑定的 socket（构造函数重挂失败/外来 socket）：立即按策略违规关（1008）。
      this.closeSocket(ws, 1008, 'no bound attachment');
      return;
    }
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(asText(message)) as Record<string, unknown>;
    } catch {
      this.closeSocket(ws, 1008, 'malformed frame');
      return;
    }

    if (frame.type === 'ping') {
      // 应用层 ping（auto-response 不可用的运行时兜底）；直接回 pong。
      ws.send(JSON.stringify({ v: TUNNEL_PROTOCOL_VERSION, type: 'pong' }));
      return;
    }
    if (frame.type === 'pong') return;

    if (frame.type === 'response') {
      // 响应帧形状校验：requestId 必须是字符串、status 必须是合法 HTTP 状态码段
      // （Response 构造器拒绝超段状态码，不校验会被伪造帧炸掉 DO）。
      const requestId = typeof frame.requestId === 'string' ? frame.requestId : '';
      const rawStatus = frame.status;
      const statusOk =
        typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 200 && rawStatus <= 599;
      if (!requestId || !statusOk) {
        this.closeSocket(ws, 1008, 'malformed response frame');
        return;
      }
      const entry = this.pending.get(requestId);
      if (!entry) {
        // 无人等这个 requestId（超时已 504 / 伪造帧）：按帧重验纪律丢弃并关（数据面不可信）。
        this.closeSocket(ws, 1008, 'unsolicited response');
        return;
      }
      // #51 按帧重验（轻量版）：注册表启停/吊销状态随帧变；哈希不重查（建连已核 + 换 key = 重连）。
      const gate = await verifyConnectCredential(this.env.CORE_DB, meta.moduleId, meta.keyHash);
      if (!gate.ok) {
        // 在途转发立刻 reject（调用面收 504/503），socket 关 1008（重连必重新核哈希）。
        this.clearPending(requestId);
        entry.reject(new Error('credential revoked'));
        this.closeSocket(ws, 1008, 'credential revoked');
        return;
      }
      this.clearPending(requestId);
      entry.resolve({
        v: TUNNEL_PROTOCOL_VERSION,
        type: 'response',
        requestId,
        status: rawStatus as number,
        headers: isHeaderMap(frame.headers),
        body: typeof frame.body === 'string' ? frame.body : null,
      });
      return;
    }

    // 其余帧型（含伪造 request）：不认识就关，不给协议外形状留活口。
    this.closeSocket(ws, 1008, 'unsupported frame');
  }

  /**
   * 断线（模块侧 close / 异常）：清内存表与该连接投递中的 pending（reject → 转发面
   * 取其余连接或 504）。断线清 attachment：socket 已死，重连必经 upgrade 重新核哈希
   * （1018/1008 语义由 routes/connect.ts 拒绝码承载，测试锁定）。
   */
  webSocketClose(ws: WebSocket): void {
    this.connections.delete(ws);
    this.rejectInFlight(new Error('tunnel socket closed'));
  }

  /** 平台异常断开（error handler 必须有，否则 DO 抛未捕获）；语义同 close。 */
  webSocketError(ws: WebSocket): void {
    this.connections.delete(ws);
    this.rejectInFlight(new Error('tunnel socket error'));
  }

  /** 在线表读数（测试连接消费；在线 = 存活 WS 会话 > 0）。 */
  connectionsSize(): number {
    return this.connections.size;
  }

  /** 断线时把「已投给这条 socket、还没回」的 pending 全部 reject（转发面兜底 504）。 */
  private rejectInFlight(reason: unknown): void {
    for (const [requestId, entry] of this.pending) {
      if (!entry.delivered) continue;
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      entry.reject(reason);
    }
  }

  private clearPending(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
    }
  }

  /** 按策略违规关（1008 policy violation）：清内存表 + 关 socket（已死则忽略）。 */
  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    this.connections.delete(socket);
    try {
      socket.close(code, reason);
    } catch {
      // 已死的 socket 关不上，忽略。
    }
  }

  /** 响应帧 → HTTP Response（隧道协议 v1：body 为 base64；content-type 等头透传）。 */
  private responseFromFrame(frame: TunnelResponseFrame): Response {
    const headers = new Headers();
    for (const [key, value] of Object.entries(frame.headers ?? {})) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
    }
    const body = frame.body ? base64ToArrayBuffer(frame.body) : null;
    return new Response(body, { status: frame.status, headers });
  }
}

/** 隧道不可用/上游异常的统一 JSON 错误面（人话，§6.5 API JSON 口径）。 */
function tunnelDown(url: URL, status: 503 | 504 | 413, message: string): Response {
  return Response.json(
    { error: 'tunnel_unavailable', status, message, path: url.pathname },
    { status },
  );
}

function asText(message: string | ArrayBuffer | Uint8Array): string {
  if (typeof message === 'string') return message;
  return new TextDecoder().decode(message);
}

/** 伪造帧防入：headers 必须是 string→string 映射，非字符串值丢弃（不炸 Response 构造）。 */
function isHeaderMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof headerValue === 'string') out[key] = headerValue;
  }
  return out;
}

/** 生成隧道请求 id（forward 入口调用；同一转发全程携带）。 */
function newTunnelRequestId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** RFC 7230 逐跳头（代理面不透传；WebSocket upgrade 头同属连接级，不进帧）。 */
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
