// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

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

/** 标准装配：注册成功、按需返回 WS。 */
function setup(overrides?: {
  registerStatus?: () => number;
  handler?: (request: Request) => Promise<Response>;
}) {
  FakeSocket.instances = [];
  const registerCalls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    registerCalls.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) : null });
    const status = overrides?.registerStatus ? overrides.registerStatus() : 200;
    return new Response(status === 200 ? JSON.stringify({ ok: true }) : JSON.stringify({ error: 'nope' }), {
      status,
    });
  });
  const sleeps: number[] = [];
  const handle = startDialHome({
    coreUrl: 'https://core.example.com/',
    moduleKey: 'super-secret-key',
    moduleId: 'hello',
    handler: overrides?.handler ?? echoHandler,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    webSocketImpl: FakeSocket as unknown as new (url: string) => WebSocketLike,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      await new Promise((r) => setTimeout(r, 0));
    },
    backoffBaseMs: 100,
    backoffMaxMs: 400,
  });
  return { handle, registerCalls, sleeps };
}

describe('hello 反连客户端（#349 决策 #108）', () => {
  it('先注册再握手：注册体带 hex(SHA-256(key)) 哈希，明文 key 不过网', async () => {
    const { handle, registerCalls } = setup();
    await settle();

    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0]!.url).toBe('https://core.example.com/api/modules/connect-register');
    const body = registerCalls[0]!.body as { moduleId: string; keyHash: string };
    expect(body.moduleId).toBe('hello');
    // sha256('super-secret-key')
    expect(body.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain('super-secret-key');

    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]!.url).toBe(
      'wss://core.example.com/api/modules/connect-ws?moduleId=hello&keyHash=' + body.keyHash,
    );
    handle.stop();
  });

  it('帧往返：宿主前缀被剥离，响应按 requestId 配对、body 走 base64', async () => {
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
        path: '/m/hello/api/health',
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

  it('断线重连：重新注册 + 新握手（重连必重核哈希，不缓存凭据）', async () => {
    const { handle, registerCalls } = setup();
    await settle();
    expect(registerCalls).toHaveLength(1);

    FakeSocket.instances[0]!.close();
    await settle();

    expect(registerCalls).toHaveLength(2);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(registerCalls[1]!.body).toEqual(registerCalls[0]!.body);
    handle.stop();
  });

  it('注册失败按指数退避重试，退避有上限', async () => {
    let attempt = 0;
    const { handle, sleeps, registerCalls } = setup({
      // 前三次全失败（触发 100 → 200 → 400），上限 400
      registerStatus: () => (attempt++ < 3 ? 503 : 200),
    });
    await settle(40);

    expect(registerCalls.length).toBeGreaterThanOrEqual(4);
    expect(sleeps.slice(0, 3)).toEqual([100, 200, 400]);
    handle.stop();
  });

  it('stop() 之后不再重连', async () => {
    const { handle, registerCalls } = setup();
    await settle();
    handle.stop();
    FakeSocket.instances[0]?.close();
    await settle();
    expect(registerCalls).toHaveLength(1);
  });
});
