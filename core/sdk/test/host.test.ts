// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDialHome, serveSdkAssetsFrom, type WebSocketLike } from '../src/host.js';

/** JSON 200 响应替身（manifest 自报成功路径用）。 */
function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

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
  sdkAssetBase?: URL | null;
  /** 测试注入的 fetch 替身（#349 U8 manifest 自报用）；缺省装一个「被调即崩」的哨兵。 */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** 模块连接清单；缺省不传 = manifest 缺省零行为（不发任何 HTTP）。 */
  manifest?: unknown;
}) {
  FakeSocket.instances = [];
  // 模块不自我注册 → 不该有任何 HTTP 调用；这里只留一个会失败的空实现（被调用即崩测试）
  const fetchCalls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl =
    overrides?.fetchImpl ??
    (async (input: string) => {
      throw new Error(`unexpected fetch: ${input}`);
    });
  const sleeps: number[] = [];
  const handle = startDialHome({
    coreUrl: 'https://core.example.com/',
    moduleKey: 'super-secret-key',
    handler: overrides?.handler ?? echoHandler,
    // 临时端口：测试不绑固定 8790——真实模块 dev 进程在跑时也能并存（走查实锤）
    moduleAddr: '127.0.0.1:0',
    sdkAssetBase: overrides?.sdkAssetBase,
    manifest: overrides?.manifest,
    fetchImpl: async (input, init) => {
      fetchCalls.push({ url: input, body: init?.body });
      return fetchImpl(input, init);
    },
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

describe('host 自供 SDK 浏览器资产（#349 走查实锤：dev 态 501 占位收掉）', () => {
  const ASSET_NAME = 'module-sdk.esm.js';
  const ASSET_BODY = 'export const sdkProbe = "asset-bytes";';

  async function assetDir(): Promise<{ dir: string; base: URL; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), 'unself-sdk-assets-'));
    await writeFile(join(dir, ASSET_NAME), ASSET_BODY);
    await writeFile(join(dir, 'module-sdk.js'), 'window.__unselfSDK = {};');
    return { dir, base: new URL(`file://${dir}/`), cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  /** 起 host（不拨号，只验本地 HTTP 面），等端口就绪。 */
  async function startLocal(overrides: {
    handler?: (request: Request) => Promise<Response>;
    sdkAssetBase?: URL | null;
  }) {
    const handle = startDialHome({
      handler: overrides.handler ?? echoHandler,
      moduleAddr: '127.0.0.1:0',
      sdkAssetBase: overrides.sdkAssetBase,
    });
    for (let i = 0; i < 50 && handle.addr() === null; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const addr = handle.addr();
    if (addr === null) throw new Error('本地宿主未就绪');
    return { handle, url: `http://${addr}` };
  }

  it('本地 HTTP：/sdk/<资产> 先于模块业务，吐包内字节与正确 content-type', async () => {
    const { base, cleanup } = await assetDir();
    const { handle, url } = await startLocal({ sdkAssetBase: base });
    try {
      const res = await fetch(`${url}/sdk/${ASSET_NAME}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/javascript');
      expect(await res.text()).toBe(ASSET_BODY);
    } finally {
      handle.stop();
      await cleanup();
    }
  });

  it('资产目录未命中（未知名）不认领，落回模块业务；allowlist 精确名字，免疫目录拼接', async () => {
    const { base, cleanup } = await assetDir();
    const { handle, url } = await startLocal({ sdkAssetBase: base });
    try {
      const res = await fetch(`${url}/sdk/not-known.js`);
      expect(res.status).toBe(200);
      const echoed = JSON.parse(await res.text()) as { path: string };
      expect(echoed.path).toBe('/sdk/not-known.js'); // 命中的是业务 echo，不是资产供应器

      // 供应器单元面：allowlist 名字必须精确等于（HTTP 客户端会先规范化 ../，这里钉守卫本体）
      const serve = serveSdkAssetsFrom(base);
      await expect(serve('/sdk/../module-sdk.esm.js')).resolves.toBeNull();
      await expect(serve('/sdk/../../etc/passwd')).resolves.toBeNull();
      await expect(serve('/sdk/sub/module-sdk.esm.js')).resolves.toBeNull();
      await expect(serve('/api/health')).resolves.toBeNull();
    } finally {
      handle.stop();
      await cleanup();
    }
  });

  it('包内无产物（sdk 未构建）→ 优雅降级：请求落回业务，不再 501 假成功', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unself-sdk-empty-'));
    try {
      const { handle, url } = await startLocal({ sdkAssetBase: new URL(`file://${dir}/`) });
      try {
        const res = await fetch(`${url}/sdk/${ASSET_NAME}`);
        expect(res.status).toBe(200); // 业务 echo 接住，而非 501/404
        expect(((await res.json()) as { path: string }).path).toBe(`/sdk/${ASSET_NAME}`);
      } finally {
        handle.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('隧道帧同优先级：/sdk/ 路径的请求帧由资产供应器应答（与部署态「资产先于 worker」一致）', async () => {
    const { base, cleanup } = await assetDir();
    const { handle } = setup({ handler: echoHandler, sdkAssetBase: base });
    await settle();
    try {
      const socket = FakeSocket.instances[0]!;
      socket.emit('message', { data: JSON.stringify({ type: 'ready' }) });
      socket.emit('message', {
        data: JSON.stringify({
          v: 1,
          type: 'request',
          requestId: 'req-sdk',
          method: 'GET',
          path: `/sdk/${ASSET_NAME}`,
          query: '',
          headers: {},
          body: null,
        }),
      });
      await settle();

      expect(socket.sent).toHaveLength(1);
      const frame = JSON.parse(socket.sent[0]!) as { status: number; body: string | null };
      expect(frame.status).toBe(200);
      expect(atob(frame.body ?? '')).toBe(ASSET_BODY);
    } finally {
      handle.stop();
      await cleanup();
    }
  });
});

describe('manifest 自报（#349 U8：模块可配置选项）', () => {
  /** 与部署者从 env 复制出的 key 完全一致的测试值（哈希即 WS 上的 keyHash）。 */
  const manifest = {
    id: 'hello',
    version: '1.0.0',
    config: [{ key: 'REGION', label: '区域', type: 'enum', options: ['us', 'eu'] }],
  };

  it('带 manifest → ready 帧后 POST /api/modules/connect-manifest?keyHash=<hash>，body = 原对象 JSON', async () => {
    const { handle, fetchCalls } = setup({ manifest, fetchImpl: async () => okJson({ ok: true }) });
    await settle();

    const url = new URL(FakeSocket.instances[0]!.url);
    const keyHash = url.searchParams.get('keyHash')!;
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);

    // 自报打在 ready 帧（握手成立）之后，不是连上就报
    expect(fetchCalls).toHaveLength(0);
    FakeSocket.instances[0]!.emit('message', { data: JSON.stringify({ type: 'ready' }) });
    await settle();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(`https://core.example.com/api/modules/connect-manifest?keyHash=${keyHash}`);
    expect(JSON.parse(fetchCalls[0]!.body as string)).toEqual(manifest);
    handle.stop();
  });

  it('上报失败（fetch reject / 500）不炸连接不重试：隧道帧照常处理，重连循环继续', async () => {
    const { handle, fetchCalls } = setup({
      manifest,
      fetchImpl: async () => new Response('boom', { status: 500 }),
    });
    await settle();

    FakeSocket.instances[0]!.emit('message', { data: JSON.stringify({ type: 'ready' }) });
    await settle();

    // 500：报了一次就不再报（不重试——下次重连再报）
    expect(fetchCalls).toHaveLength(1);

    // 隧道数据面不受影响：请求帧照常应答
    FakeSocket.instances[0]!.emit('message', {
      data: JSON.stringify({
        v: 1, type: 'request', requestId: 'req-m', method: 'GET', path: '/api/health', query: '', headers: {}, body: null,
      }),
    });
    await settle();
    expect(FakeSocket.instances[0]!.sent).toHaveLength(1);

    // 重连循环继续：干净断开立即重试（不惩罚），新连接 ready 后再报一次
    FakeSocket.instances[0]!.close();
    await settle(40);
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2);
    const reconnected = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    reconnected.emit('message', { data: JSON.stringify({ type: 'ready' }) });
    await settle();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    expect(new URL(fetchCalls[1]!.url).pathname).toBe('/api/modules/connect-manifest');
    handle.stop();
  });

  it('无 manifest = 零行为：ready 后 fetch 零调用（回归锁定既有 fetchCalls===0 语义）', async () => {
    const { handle, fetchCalls } = setup();
    await settle();
    FakeSocket.instances[0]!.emit('message', { data: JSON.stringify({ type: 'ready' }) });
    await settle();
    expect(fetchCalls).toHaveLength(0);
    handle.stop();
  });
});
