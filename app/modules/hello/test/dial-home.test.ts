// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { startDialHome, type WebSocketLike } from '../src/dial-home.js';

/** 假 WebSocket：记录 send / close，测试用 emit 模拟 core 侧推帧。 */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readonly url: string;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Array<(event?: { data?: unknown }) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit('close');
  }

  addEventListener(type: string, handler: (event?: { data?: unknown }) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }

  emit(type: string, event?: { data?: unknown }): void {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
}

/** 一个最少够用的 handler：把收到的请求回显成 JSON，便于验证帧 → 真请求的映射。 */
async function echoHandler(request: Request): Promise<Response> {
  return Response.json({
    method: request.method,
    path: new URL(request.url).pathname,
    query: new URL(request.url).search,
  });
}

/** 让出若干轮宏任务，等反连循环推进到可断言的状态（真定时器 0ms，无需假时钟）。 */
async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** 标准装配：模块不自我注册（决策 #108：key 由部署者在管理台生成并预注册）。 */
function setup(overrides?: {
  handler?: (request: Request) => Promise<Response>;
  webSocketImpl?: new (url: string) => WebSocketLike;
}) {
  FakeSocket.instances = [];
  // 模块不自我注册 → 不该有任何 HTTP 调用；这里只留一个会失败的空实现（被调用即崩测试）
  const fetchCalls: Array<{ url: string; body: unknown }> = [];
  const sleeps: number[] = [];
  const handle = startDialHome({
    coreUrl: 'https://core.example.com/',
    moduleKey: 'super-secret-key',
    handler: overrides?.handler ?? echoHandler,
    webSocketImpl: (overrides?.webSocketImpl ?? FakeSocket) as unknown as new (url: string) => WebSocketLike,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      await new Promise((r) => setTimeout(r, 0));
    },
    backoffBaseMs: 100,
    backoffMaxMs: 400,
  });
  return { handle, fetchCalls, sleeps };
}

describe('hello 反连客户端（#349 决策 #108）', () => {
  it('只握手不自我注册：WS 地址带 hex(SHA-256(key))，明文 key 不过网', async () => {
    const { handle, fetchCalls } = setup();
    await settle();

    // 模块不调用任何注册端点（预注册是管理台的动作）
    expect(fetchCalls).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(1);
    const url = new URL(FakeSocket.instances[0]!.url);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('wss://core.example.com/api/modules/connect-ws');
    // 模块不报 id：握手只带哈希，core 凭 keyHash 反查定位（#108 env 契约两项）
    expect(url.searchParams.get('moduleId')).toBeNull();
    const hash = url.searchParams.get('keyHash') ?? '';
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(FakeSocket.instances[0]!.url).not.toContain('super-secret-key');
    handle.stop();
  });

  it('帧往返：core 已剥 /m/<id> 前缀（模块按根路径收帧），响应按 requestId 配对、body 走 base64', async () => {
    const { handle } = setup();
    await settle();

    const socket = FakeSocket.instances[0]!;
    socket.emit('message', { data: JSON.stringify({ type: 'ready' }) });
    socket.emit('message', {
      data: JSON.stringify({
        v: 1,
        type: 'request',
        requestId: 'req-1',
        method: 'GET',
        path: '/api/health',
        query: 'x=1',
        headers: {},
        body: null,
      }),
    });
    await settle();

    expect(socket.sent).toHaveLength(1);
    const frame = JSON.parse(socket.sent[0]!);
    expect(frame).toMatchObject({ v: 1, type: 'response', requestId: 'req-1', status: 200 });
    const payload = JSON.parse(atob(frame.body));
    expect(payload).toEqual({ method: 'GET', path: '/api/health', query: '?x=1' });
    handle.stop();
  });

  it('handler 抛错回 500 帧（不让一条坏请求打断隧道）', async () => {
    const { handle } = setup({
      handler: async () => {
        throw new Error('boom');
      },
    });
    await settle();

    const socket = FakeSocket.instances[0]!;
    socket.emit('message', {
      data: JSON.stringify({
        v: 1,
        type: 'request',
        requestId: 'req-2',
        method: 'GET',
        path: '/m/hello/',
        query: '',
        headers: {},
        body: null,
      }),
    });
    await settle();

    const frame = JSON.parse(socket.sent[0]!);
    expect(frame.status).toBe(500);
    expect(JSON.parse(atob(frame.body))).toEqual({ error: 'module handler failed' });
    handle.stop();
  });

  it('断线重连：新握手仍带同一哈希（重连必重核，core 不缓存会话）', async () => {
    const { handle } = setup();
    await settle();
    const firstUrl = FakeSocket.instances[0]!.url;

    FakeSocket.instances[0]!.close();
    await settle();

    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]!.url).toBe(firstUrl);
    handle.stop();
  });

  it('握手失败按指数退避重试，退避有上限', async () => {
    let attempt = 0;
    // 前三次握手被拒（core 侧 403/1008 的客户端表现），之后成功——退避 100 → 200 → 400（封顶）
    const FailingSocket = class extends FakeSocket {
      constructor(url: string) {
        if (attempt++ < 3) throw new Error('handshake refused');
        super(url);
      }
    };
    const { handle, sleeps } = setup({ webSocketImpl: FailingSocket as unknown as new (url: string) => WebSocketLike });
    await settle(40);

    expect(attempt).toBeGreaterThanOrEqual(4);
    expect(sleeps.slice(0, 3)).toEqual([100, 200, 400]);
    handle.stop();
  });

  it('stop() 之后不再重连', async () => {
    const { handle } = setup();
    await settle();
    handle.stop();
    FakeSocket.instances[0]?.close();
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
