// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块侧 Durable Objects 的 Node 替身（#382 轨道 D）。
 *
 * 定位（决策 #106）：DO 是 CF 落点的**过渡事实**而非产品承诺。模块代码不该知道
 * 「我跑在哪种 DO 上」——它只该知道 `env.<BINDING>.idFromName(name).get(id).fetch(req)`
 * 这一个调用面，以及 DO 类内部的 `state.acceptWebSocket / getWebSockets / waitUntil /
 * storage.setAlarm`。本文件就是这套调用面的 Node 实现：
 *
 * - CF 部署：wrangler 注入官方 namespace，本文件不参与；
 * - 自部署：`@unself/sdk/host` 用本文件注入同形状替身，模块源码零改动。
 *
 * 单机上 DO 的四层能力全部塌缩成进程内结构，不需要任何外部服务：
 * - 「按名寻址到唯一实例」→ 一张 `Map<name, 实例>`；
 * - 「单实例串行执行」→ 每个 name 一条 promise 链（`entry.queue`）；
 * - 「连接表」→ `Set<socket>`（单机没有休眠，不需要 `serializeAttachment` 真序列化）；
 * - 「持久 alarm」→ 注入的 `AlarmStore`（进程重启后靠它重排，见 `restoreAlarms`）。
 *
 * 唯一的平台垫片是 `WebSocketPair` 与 `101 + webSocket` 的 Response——Node 的
 * `Response` 构造器拒绝 101，这里只放行这一种形状，其余 HTTP 语义原样不动。
 *
 * 与 `app/workbench/src/node/tunnel-runtime.ts` 同源：那边是 core 对自己 `TunnelRoom`
 * 做的一次性适配，这边是把它抽成所有模块共用的能力。业务（验签、帧配对、广播）在模块
 * 自己的 DO 类里，本文件不含任何业务判断。
 *
 * **不建模的两件事**（单机上无意义，照搬只会变复杂）：
 * - 休眠/逐出：实例建了就一直在内存里（无空闲回收）。房间数 = 内存占用上限，大实例要自己限流；
 * - `serializeAttachment` 真序列化：对象原样挂着（没有跨进程/休眠，序列化纯开销）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type RawData, type WebSocket as WsSocket } from 'ws';

/** 模块 DO 类用到的平台面最小子集（`grep 'this.state\.'` 的实际用量）。 */
export interface WorkersWebSocket {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(data: unknown): void;
  deserializeAttachment(): unknown;
}

export interface WorkersDurableObjectStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface WorkersDurableObjectState {
  acceptWebSocket(socket: WorkersWebSocket): void;
  getWebSockets(): WorkersWebSocket[];
  waitUntil(promise: Promise<unknown>): void;
  storage: WorkersDurableObjectStorage;
}

/** DO 类实例面：CF 的 `DurableObject` 基类等价物——全是可选方法。 */
export interface DurableObjectInstance {
  fetch?(request: Request): Response | Promise<Response>;
  webSocketMessage?(socket: WorkersWebSocket, message: string | ArrayBuffer): void | Promise<void>;
  webSocketClose?(socket: WorkersWebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
  webSocketError?(socket: WorkersWebSocket, error: unknown): void | Promise<void>;
  alarm?(): void | Promise<void>;
}

/** DO 类构造函数形状：普通 class，`(state, env)`，与 CF 一致。 */
export interface DurableObjectClass {
  new (state: WorkersDurableObjectState, env: Record<string, unknown>): DurableObjectInstance;
}

/** `env.<BINDING>` 的形状：模块只用到这三个方法。 */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface DurableObjectIdLike {
  readonly name: string;
  toString(): string;
  equals(other: unknown): boolean;
}

export interface DurableObjectStubLike {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

/**
 * alarm 的跨重启账本。`Scheduler` 依赖 `storage.getAlarm()` 在进程重启后仍读得到——
 * 纯 `setTimeout` 会随进程消失，所以这张纸必须落到模块自己的库里（sqlite/pg 一行表即可）。
 * 缺省实现只在内存里，重启后排不上（那是调用方的选择，不是静默降级：注释已说明）。
 */
export interface AlarmStore {
  get(key: string): Promise<number | null> | number | null;
  set(key: string, scheduledTime: number | null): Promise<void> | void;
  /** 启动时枚举未触发的 alarm（`restoreAlarms` 用）；缺省 = 不恢复。 */
  all?(): Promise<Array<{ key: string; scheduledTime: number }>>;
}

export interface DurableObjectRuntimeOptions {
  /** 交给 DO 构造函数的 env（同一份，含本文件注入的 namespace——先造 runtime 再填绑定）。 */
  env: Record<string, unknown>;
  alarms?: AlarmStore;
  /** 定时器注入（自管调度/测试用）；返回取消函数。 */
  schedule?: (scheduledTime: number, run: () => void) => () => void;
}

export interface DurableObjectRuntime {
  /**
   * 为 `binding` 造 namespace，并把 `cls` 的所有实例挂在它下面。
   * 同一个 runtime 内重复调用同名 binding 返回同一份（env 组装期会被调用一次）。
   */
  namespace(binding: string, cls: DurableObjectClass): DurableObjectNamespaceLike;
  /** 桥接一次 HTTP upgrade：module handler 内 `new WebSocketPair()` 并返回 101 后接线。 */
  handleUpgrade(
    request: Request,
    incoming: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    appFetch: (request: Request) => Response | Promise<Response>,
  ): Promise<void>;
  /** 关掉所有连接与定时器（进程退出）。 */
  close(): Promise<void>;
}

/** 模块 DO 的 env 上，绑定名 → 类的声明形状（`host.startDialHome` 的入参）。 */
export type DurableObjectBindings = Record<string, DurableObjectClass>;

/** 内存版 alarm 账本：单进程够用，重启即丢（要跨重启就传 `AlarmStore`）。 */
export function createMemoryAlarmStore(): AlarmStore {
  const book = new Map<string, number>();
  return {
    get: (key) => book.get(key) ?? null,
    set: (key, scheduledTime) => {
      if (scheduledTime === null) book.delete(key);
      else book.set(key, scheduledTime);
    },
    all: async () => [...book.entries()].map(([key, scheduledTime]) => ({ key, scheduledTime })),
  };
}

/** `setTimeout` 的上限（约 24.8 天）；超过要分段，否则 Node 会立刻触发。 */
const MAX_TIMEOUT_MS = 2_147_483_647;

function defaultSchedule(scheduledTime: number, run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const arm = (target: number) => {
    if (cancelled) return;
    const delay = Math.max(0, target - Date.now());
    timer = setTimeout(() => {
      if (target - Date.now() > 0) arm(target);
      else run();
    }, Math.min(delay, MAX_TIMEOUT_MS));
    // 定时器不该让进程为它活着（模块进程的存活由 HTTP/隧道决定）。
    (timer as { unref?: () => void }).unref?.();
  };
  arm(scheduledTime);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

class NodeDurableObjectId implements DurableObjectIdLike {
  constructor(readonly name: string) {}
  toString(): string {
    return this.name;
  }
  equals(other: unknown): boolean {
    return other instanceof NodeDurableObjectId && other.name === this.name;
  }
}

/**
 * workers `WebSocket` 的 Node 替身：`send` 在真 ws 尚未绑定时先入队——DO 建连即发
 * ready 帧，而真握手要等 handler 返回 101 之后才完成，顺序不能反。
 * `serializeAttachment` 在单机上不做序列化（对象原样挂着）：没有跨进程/休眠，序列化纯开销。
 */
class NodeWorkersSocket implements WorkersWebSocket {
  private ws: WsSocket | null = null;
  private queue: Array<string | Uint8Array> = [];
  private attachment: unknown = null;
  private closed = false;

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.closed) return;
    const payload = typeof data === 'string' ? data : data instanceof Uint8Array ? data : new Uint8Array(data);
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
        // 已断：关闭语义由 closed 标记承担。
      }
    }
  }

  serializeAttachment(data: unknown): void {
    this.attachment = data;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  /** 真握手完成：把排队帧按序放出。 */
  bind(ws: WsSocket): void {
    this.ws = ws;
    for (const payload of this.queue) ws.send(payload);
    this.queue = [];
  }
}

/** 一次 upgrade 的上下文：DO 在 handler 里 `new WebSocketPair()` 时把 server 槽挂进来。 */
interface PendingUpgrade {
  socket: NodeWorkersSocket | null;
  entry: Entry | null;
}

const pendingUpgrade = new AsyncLocalStorage<PendingUpgrade>();

/** `new WebSocketPair()` 的 Node 形态：服务端槽从当前 upgrade 上下文取。 */
class NodeWebSocketPair {
  0: unknown;
  1: NodeWorkersSocket;

  constructor() {
    const pending = pendingUpgrade.getStore();
    const server = new NodeWorkersSocket();
    if (pending) pending.socket = server;
    // 客户端槽由 host 用真 socket 顶替（见 handleUpgrade），这里只占位。
    this[0] = { __unselfNodeClient: true };
    this[1] = server;
  }
}

let globalsInstalled = false;

/**
 * 安装 Node 侧运行面垫片（进程级，一次）：
 * - `WebSocketPair`：交给本文件的 upgrade 桥接；
 * - `Response`：Node 拒绝 101，这里只对「101 + webSocket」放行，其余原样走真 Response。
 */
export function installWorkersGlobals(): void {
  if (globalsInstalled) return;
  globalsInstalled = true;
  const scope = globalThis as unknown as {
    WebSocketPair: typeof NodeWebSocketPair;
    Response: typeof Response;
  };
  scope.WebSocketPair = NodeWebSocketPair;

  const RealResponse = scope.Response;
  // 参数类型沿用真构造器（ES2022 lib 里没有 `BodyInit`，从 Response 自身取）。
  type ResponseBody = ConstructorParameters<typeof RealResponse>[0];
  const PatchedResponse = function (body: ResponseBody, init?: ResponseInit) {
    if (init?.status === 101 && 'webSocket' in init) {
      return {
        status: 101,
        webSocket: (init as { webSocket: unknown }).webSocket,
        headers: new Headers(),
      } as unknown as Response;
    }
    return new RealResponse(body, init);
  } as unknown as typeof Response;
  // 静态面靠原型链继承（`Response.json` 等）；`instanceof` 靠 `.prototype`——两者都要接，
  // 否则模块/Hono 里的 `res instanceof Response` 会集体变假。
  Object.setPrototypeOf(PatchedResponse, RealResponse);
  PatchedResponse.prototype = RealResponse.prototype;
  scope.Response = PatchedResponse;
}

interface Entry {
  readonly instance: DurableObjectInstance;
  readonly state: NodeDurableObjectState;
  /** 同 name 串行：CF 保证同一 DO 实例的输入不交错，这里显式建模。 */
  queue: Promise<unknown>;
}

class NodeDurableObjectState implements WorkersDurableObjectState {
  private readonly sockets = new Set<NodeWorkersSocket>();
  private instance: DurableObjectInstance | null = null;
  readonly storage: WorkersDurableObjectStorage;

  constructor(
    private readonly key: string,
    alarms: AlarmStore,
    private readonly schedule: (scheduledTime: number, run: () => void) => () => void,
    private readonly enqueue: (task: () => unknown) => Promise<unknown>,
  ) {
    this.storage = {
      getAlarm: async () => await alarms.get(this.key),
      setAlarm: async (scheduledTime: number) => {
        await alarms.set(this.key, scheduledTime);
        this.arm(scheduledTime);
      },
      deleteAlarm: async () => {
        await alarms.set(this.key, null);
        this.cancel();
      },
    };
  }

  private cancelTimer: (() => void) | null = null;

  attach(instance: DurableObjectInstance): void {
    this.instance = instance;
  }

  /** 按账本重排定时器（启动恢复用）。 */
  arm(scheduledTime: number): void {
    this.cancelTimer?.();
    this.cancelTimer = this.schedule(scheduledTime, () => {
      void this.enqueue(async () => {
        await this.instance?.alarm?.();
      });
    });
  }

  private cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  acceptWebSocket(socket: WorkersWebSocket): void {
    this.sockets.add(socket as NodeWorkersSocket);
  }

  getWebSockets(): WorkersWebSocket[] {
    return [...this.sockets];
  }

  /** 连接断开后不再出现在 `getWebSockets()` 里（对齐 CF：休眠重建时只看见活的）。 */
  forget(socket: WorkersWebSocket): void {
    this.sockets.delete(socket as NodeWorkersSocket);
  }

  waitUntil(promise: Promise<unknown>): void {
    // 单进程没有 invocation 生命周期，挂着的活自己跑完即可。拒绝必须就地吃掉并记日志：
    // Node 对未处理拒绝默认终止进程，而投影/清理失败在 CF 上只是丢一条日志。
    void promise.catch((error: unknown) => {
      console.warn(`durable-object ${this.key}: waitUntil 任务失败`, error);
    });
  }

  closeAll(code: number, reason: string): void {
    this.cancel();
    for (const socket of this.sockets) socket.close(code, reason);
    this.sockets.clear();
  }
}

const rawDataToMessage = (data: RawData, isBinary: boolean): string | ArrayBuffer => {
  if (!isBinary) {
    if (typeof data === 'string') return data;
    return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
  }
  if (data instanceof ArrayBuffer) return data;
  if (Array.isArray(data)) {
    const merged = Buffer.concat(data);
    return merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength) as ArrayBuffer;
  }
  const buf = data as Buffer;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

/** 把 handler 的 HTTP 响应写回原始 upgrade socket（未升级成功的分支）。 */
async function writeRawResponse(socket: Duplex, response: Response): Promise<void> {
  const body = new Uint8Array(await response.arrayBuffer());
  const lines: string[] = [`HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ''}`];
  response.headers.forEach((value, key) => lines.push(`${key}: ${value}`));
  lines.push(`content-length: ${body.byteLength}`, 'connection: close', '', '');
  socket.write(lines.join('\r\n'));
  if (body.byteLength > 0) socket.write(body);
  socket.end();
}

/** 创建一套 DO 运行时（一进程一套：所有 binding 共用串行队列与 upgrade 桥接）。 */
export function createDurableObjectRuntime(options: DurableObjectRuntimeOptions): DurableObjectRuntime {
  installWorkersGlobals();
  const alarms = options.alarms ?? createMemoryAlarmStore();
  const schedule = options.schedule ?? defaultSchedule;
  const namespaces = new Map<string, DurableObjectNamespaceLike>();
  /** 全部实例（close 时统一收连接）；与 namespaces 同寿命。 */
  const allEntries = new Set<Entry>();
  const wss = new WebSocketServer({ noServer: true });

  function createNamespace(binding: string, cls: DurableObjectClass): DurableObjectNamespaceLike {
    const existing = namespaces.get(binding);
    if (existing) return existing;

    const entries = new Map<string, Entry>();

    const resolve = (name: string): Entry => {
      const existingEntry = entries.get(name);
      if (existingEntry) return existingEntry;
      const key = `${binding}:${name}`;
      let entry: Entry;
      const state = new NodeDurableObjectState(key, alarms, schedule, (task) => enqueueOn(entry, task));
      const instance = new cls(state, options.env);
      state.attach(instance);
      entry = { instance, state, queue: Promise.resolve() };
      entries.set(name, entry);
      allEntries.add(entry);
      return entry;
    };

    const namespace: DurableObjectNamespaceLike = {
      idFromName: (name: string) => new NodeDurableObjectId(name),
      get: (id: DurableObjectIdLike) => {
        const name = typeof id === 'string' ? id : id.name;
        const entry = resolve(name);
        return {
          fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
            // WebSocket 升级必须用同一个 Request 对象：重建会丢 upgrade 元数据（#349 真机取证）。
            const request = input instanceof Request ? input : new Request(String(input), init);
            const pending = pendingUpgrade.getStore();
            if (pending) pending.entry = entry;
            return enqueueOn(entry, async () => {
              if (!entry.instance.fetch) {
                return new Response(JSON.stringify({ error: `${binding} 未实现 fetch` }), {
                  status: 501,
                  headers: { 'content-type': 'application/json' },
                });
              }
              return await entry.instance.fetch(request);
            }) as Promise<Response>;
          },
        };
      },
    };

    namespaces.set(binding, namespace);

    // 启动恢复：账本里属于本 binding 的 alarm 重排（进程重启后 Scheduler 仍会在 03:00 醒）。
    if (alarms.all) {
      void (async () => {
        const prefix = `${binding}:`;
        for (const { key, scheduledTime } of await alarms.all!()) {
          if (!key.startsWith(prefix)) continue;
          const name = key.slice(prefix.length);
          resolve(name).state.arm(scheduledTime);
        }
      })().catch(() => {
        // 恢复失败不阻塞启动：闹钟丢了只意味着 GC 晚一轮，准备下次 setAlarm 时自愈。
      });
    }

    return namespace;
  }

  return {
    namespace: createNamespace,

    async handleUpgrade(request, incoming, socket, head, appFetch): Promise<void> {
      const pending: PendingUpgrade = { socket: null, entry: null };
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
      const entry = pending.entry;
      if (!server || !entry) {
        await writeRawResponse(socket, new Response('durable object upgrade incomplete', { status: 500 }));
        return;
      }
      wss.handleUpgrade(incoming, socket, head, (ws) => {
        server.bind(ws);
        ws.on('message', (data: RawData, isBinary: boolean) => {
          const message = rawDataToMessage(data, isBinary);
          void enqueueOn(entry, () => entry.instance.webSocketMessage?.(server, message));
        });
        ws.on('close', (code: number, reason: Buffer) => {
          entry.state.forget(server);
          void enqueueOn(entry, () =>
            entry.instance.webSocketClose?.(server, code, reason.toString('utf8'), code === 1000),
          );
        });
        ws.on('error', (error: unknown) => {
          entry.state.forget(server);
          void enqueueOn(entry, () => entry.instance.webSocketError?.(server, error));
        });
      });
    },

    async close(): Promise<void> {
      for (const entry of allEntries) entry.state.closeAll(1001, 'server shutdown');
      allEntries.clear();
      namespaces.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** 队列入队（fetch 与 upgrade 事件处理器共用同一条串行链，对齐 CF 的输入串行语义）。 */
function enqueueOn(entry: Entry, task: () => unknown): Promise<unknown> {
  const run = entry.queue.then(task);
  entry.queue = run.catch(() => {});
  return run;
}
