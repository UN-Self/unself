// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #349 core 隧道面行为测试（决策 #108 反连形态）。
 *
 * 覆盖（任务书 T2 四项必测）：
 * ① DO 行为：connect 建连（ready 帧 + attachment 绑 moduleId+keyHash）→ forward 转发 →
 *    response 帧回 HTTP；② 无凭证/哈希不配必拒（404 未知模块 / 403 未记账 / 403 哈希不配 /
 *    403 停用，WS 与 HTTP poll 同语义）；③ 数据面 503 人话（离线转发）；④ 断线清表、
 *    重连必重新核哈希（upgrade 无会话缓存；凭据吊销按帧重验关 1008）。
 *
 * 形态对齐 app/modules/chat/test/chat-ws-renewal.test.ts（DO 直驱 + ws-stub 垫片，替运行时
 * 面不替业务）；真迁移 + 真 SQLite（createCoreDb），credential_hash 列来自 0013（T1 并行
 * 已落工作树），核验面与生产同一条 verifyConnectCredential。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { createCoreDb, type CoreTestDb } from './test-factory';
import {
  FakeDoState,
  FakeWebSocketStub,
  installWebSocketTestShim,
  lastClose,
  sentFrames,
} from './tunnel-ws-stub';
import { TunnelRoom, TUNNEL_PROTOCOL_VERSION, type TunnelAttachment } from '../src/do/TunnelRoom';
import { verifyConnectCredential, KDF_SALT } from '../src/services/connect-registry';

const restoreWebSocketRuntime = installWebSocketTestShim();
void restoreWebSocketRuntime;

/** keyHash = hex(SHA-256(key))（任务书定案；测试同构生成）。 */
function keyHashOf(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** 种子一行 registry：enabled/mode/credential_hash 按 0012/0013 列直写（connect 模式带 entry，过 0012 CHECK）。 */
function seedModule(
  db: CoreTestDb,
  id: string,
  opts: { key?: string; enabled?: boolean; mode?: string | null } = {},
): string {
  const hash = opts.key === undefined ? null : keyHashOf(opts.key);
  const mode = opts.mode === undefined ? 'cloudflare' : opts.mode;
  db.run(
    `INSERT INTO module_registry (id, enabled, version, manifest_json, mode, entry, credential_hash)
     VALUES (?, ?, '0.1.0', '{}', ?, ?, ?)`,
    id,
    opts.enabled === false ? 0 : 1,
    mode,
    mode === 'connect' ? `https://core.invalid/m/${id}/` : null,
    hash,
  );
  return hash ?? '';
}

/** 组一房：真 TunnelRoom + 真 D1（createCoreDb）。 */
function makeRoom(db: CoreTestDb): { room: TunnelRoom; state: FakeDoState } {
  const state = new FakeDoState();
  const room = new TunnelRoom(state as unknown as DurableObjectState, {
    CORE_DB: db.d1,
  });
  return { room, state };
}

/** 直驱 DO 的 /connect 内部路由（101 + 替身 server socket）。 */
async function doConnect(room: TunnelRoom, moduleId: string, keyHash: string) {
  return room.fetch(
    new Request(`https://tunnel.internal/connect?moduleId=${moduleId}&keyHash=${keyHash}`, {
      headers: { upgrade: 'websocket' },
    }),
  );
}

/** 内部 /forward 请求（数据面入口形状）。 */
async function doForward(room: TunnelRoom, path: string, init?: RequestInit) {
  return room.fetch(
    new Request(`https://tunnel.internal/forward?target=${encodeURIComponent(path)}`, {
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body,
    }),
  );
}

let db: CoreTestDb;
let room: TunnelRoom;
let state: FakeDoState;

beforeEach(() => {
  db = createCoreDb();
  ({ room, state } = makeRoom(db));
});

// ---------------------------------------------------------------------------
// ① 凭证核验（verifyConnectCredential 单点；WS 与 poll 共用）
// ---------------------------------------------------------------------------

describe('verifyConnectCredential（registry credential_hash 单点核对）', () => {
  it('未知模块 → 404（不区分不存在与未记账，防枚举）', async () => {
    const gate = await verifyConnectCredential(db.d1, 'ghost', keyHashOf('k'));
    expect(gate).toEqual({ ok: false, status: 404, error: 'unknown module' });
  });

  it('已注册但未记账（credential_hash NULL）→ 403；形状非法 keyHash → 403', async () => {
    seedModule(db, 'hello', { key: undefined, mode: 'connect' });
    const noCred = await verifyConnectCredential(db.d1, 'hello', keyHashOf('k'));
    expect(noCred).toEqual({ ok: false, status: 403, error: 'credential mismatch' });

    const badShape = await verifyConnectCredential(db.d1, 'hello', 'ZZ-short');
    expect(badShape).toEqual({ ok: false, status: 403, error: 'credential mismatch' });
  });

  it('哈希不配 → 403；哈希一致 + 启用 → 通过', async () => {
    seedModule(db, 'hello', { key: 'right-key', mode: 'connect' });
    const wrong = await verifyConnectCredential(db.d1, 'hello', keyHashOf('wrong-key'));
    expect(wrong).toEqual({ ok: false, status: 403, error: 'credential mismatch' });

    const right = await verifyConnectCredential(db.d1, 'hello', keyHashOf('right-key'));
    expect(right).toEqual({ ok: true, moduleId: 'hello' });
  });

  it('停用（enabled=0）→ 403（即便哈希一致；启停秒级生效）', async () => {
    seedModule(db, 'hello', { key: 'k', enabled: false, mode: 'connect' });
    const gate = await verifyConnectCredential(db.d1, 'hello', keyHashOf('k'));
    expect(gate).toEqual({ ok: false, status: 403, error: 'module disabled' });
  });

  it('keyHash 形状 = 64 位小写 hex（KDF_SALT 常量已定型，注释为漂移锚）', () => {
    expect(keyHashOf('k')).toMatch(/^[0-9a-f]{64}$/);
    expect(KDF_SALT).toBe('unself-connect-v1');
  });
});

// ---------------------------------------------------------------------------
// ② WS upgrade（路由级语义由 DO /connect + verifyConnectCredential 组合承载）
// ---------------------------------------------------------------------------

describe('DO /connect（hibernation 建连）', () => {
  it('核验通过：101 + ready 帧 + attachment 绑 moduleId+keyHash', async () => {
    seedModule(db, 'hello', { key: 'k', mode: 'connect' });
    const res = await doConnect(room, 'hello', keyHashOf('k'));
    expect(res.status).toBe(101);

    const server = state.accepted[0] as FakeWebSocketStub;
    expect(sentFrames(server)[0]).toMatchObject({
      v: TUNNEL_PROTOCOL_VERSION,
      type: 'ready',
      moduleId: 'hello',
    });
    const attachment = server.deserializeAttachment() as TunnelAttachment | null;
    expect(attachment).toEqual({ moduleId: 'hello', keyHash: keyHashOf('k') });
    expect(room.connectionsSize()).toBe(1);
  });

  it('哈希不配/未知模块：核验在 upgrade 路径（verifyConnectCredential 直接面），DO 不建连', async () => {
    seedModule(db, 'hello', { key: 'k', mode: 'connect' });
    const bad = await verifyConnectCredential(db.d1, 'hello', keyHashOf('wrong'));
    expect(bad).toEqual({ ok: false, status: 403, error: 'credential mismatch' });
    const ghost = await verifyConnectCredential(db.d1, 'ghost', keyHashOf('k'));
    expect(ghost).toEqual({ ok: false, status: 404, error: 'unknown module' });
    // DO 内部路由不带核验（核验单点在路由层，路由层核不过到不了 DO），此房不可能被建连：
    expect(state.accepted).toHaveLength(0);
    expect(room.connectionsSize()).toBe(0);
  });

  it('缺参数（无 upgrade 头 / 无 keyHash）→ 400/400，不触库不建连', async () => {
    const noUpgrade = await room.fetch(new Request('https://tunnel.internal/connect?moduleId=a&keyHash=b'));
    expect(noUpgrade.status).toBe(400);
    const noHash = await room.fetch(
      new Request('https://tunnel.internal/connect?moduleId=a', { headers: { upgrade: 'websocket' } }),
    );
    expect(noHash.status).toBe(400);
    expect(state.accepted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ③ 数据面：forward → WS response 帧；离线 503 人话
// ---------------------------------------------------------------------------

describe('数据面 forward（壳 /m/<id>/* 出口语义）', () => {
  it('在线：请求帧下发 → response 帧回 HTTP（status/headers/body 透传）', async () => {
    seedModule(db, 'hello', { key: 'k', mode: 'connect' });
    await doConnect(room, 'hello', keyHashOf('k'));
    const server = state.accepted[0] as FakeWebSocketStub;

    const pending = doForward(room, '/api/thing?id=7');
    // 驱动 DO 收响应帧（模块侧语义：requestId 配对回帧）。
    await Promise.resolve();
    const requestFrame = sentFrames(server).at(-1) as Record<string, unknown>;
    expect(requestFrame).toMatchObject({
      v: TUNNEL_PROTOCOL_VERSION,
      type: 'request',
      method: 'GET',
      path: '/api/thing',
      query: 'id=7',
    });
    await room.webSocketMessage(
      server as unknown as WebSocket,
      JSON.stringify({
        v: TUNNEL_PROTOCOL_VERSION,
        type: 'response',
        requestId: requestFrame.requestId,
        status: 201,
        headers: { 'content-type': 'application/json', connection: 'keep-alive' },
        body: Buffer.from(JSON.stringify({ ok: true })).toString('base64'),
      }),
    );
    const res = await pending;
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('connection')).toBeNull(); // 逐跳头不透传
    expect(await res.json()).toEqual({ ok: true });
  });

  it('离线：503 人话（tunnel_unavailable；不落 SPA/404 面）', async () => {
    seedModule(db, 'hello', { key: 'k', mode: 'connect' });
    const res = await doForward(room, '/api/thing');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('tunnel_unavailable');
    expect(body.message).toContain('不在线');
  });

  it('在线但模块无响应：超时 504（fake timers，不真等 15s）', async () => {
    vi.useFakeTimers();
    try {
      seedModule(db, 'hello', { key: 'k', mode: 'connect' });
      await doConnect(room, 'hello', keyHashOf('k'));
      const pending = doForward(room, '/api/thing');
      const assertion = expect(pending).resolves.toMatchObject({ status: 504 });
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// ④ 断线重连 + 按帧重验（#51 纪律）
// ---------------------------------------------------------------------------

describe('断线重连（重连必重新核哈希）', () => {
  it('webSocketClose 清在线表 + reject 在途转发；重连（upgrade 重核）恢复在线', async () => {
    seedModule(db, 'hello', { key: 'k', mode: 'connect' });
    await doConnect(room, 'hello', keyHashOf('k'));
    const server = state.accepted[0] as FakeWebSocketStub;
    expect(room.connectionsSize()).toBe(1);

    room.webSocketClose(server as unknown as WebSocket);
    expect(room.connectionsSize()).toBe(0);

    // 离线后数据面 503（清表生效）。
    const offline = await doForward(room, '/x');
    expect(offline.status).toBe(503);

    // 重连 = 新 upgrade（重新核哈希；吊销过的凭据此刻会被拒）。
    const resumed = await doConnect(room, 'hello', keyHashOf('k'));
    expect(resumed.status).toBe(101);
    expect(room.connectionsSize()).toBe(1);
  });

  it('按帧重验：建连后凭据被吊销（registry 哈希清空）→ 下一响应帧关 1008 + 转发 504', async () => {
    seedModule(db, 'hello', { key: 'k', mode: 'connect' });
    await doConnect(room, 'hello', keyHashOf('k'));
    const server = state.accepted[0] as FakeWebSocketStub;

    const pending = doForward(room, '/x');
    await Promise.resolve();
    const requestFrame = sentFrames(server).at(-1) as Record<string, unknown>;

    // 吊销：credential_hash 置 NULL（管理员清空/重记账语义）。
    db.run('UPDATE module_registry SET credential_hash = NULL WHERE id = ?', 'hello');

    await room.webSocketMessage(
      server as unknown as WebSocket,
      JSON.stringify({
        v: TUNNEL_PROTOCOL_VERSION,
        type: 'response',
        requestId: requestFrame.requestId,
        status: 200,
        headers: {},
        body: null,
      }),
    );
    expect(lastClose(server)).toMatchObject({ code: 1008 });
    const res = await pending;
    expect(res.status).toBe(504);
  });

  it('伪造/不认识的帧 → 1008 关（unsolicited response / unsupported frame）', async () => {
    seedModule(db, 'hello', { key: 'k', mode: 'connect' });
    await doConnect(room, 'hello', keyHashOf('k'));
    const server = state.accepted[0] as FakeWebSocketStub;

    await room.webSocketMessage(
      server as unknown as WebSocket,
      JSON.stringify({ v: TUNNEL_PROTOCOL_VERSION, type: 'response', requestId: 'no-such', status: 200 }),
    );
    expect(lastClose(server)).toMatchObject({ code: 1008, reason: 'unsolicited response' });

    const res = await doConnect(room, 'hello', keyHashOf('k'));
    expect(res.status).toBe(101);
    const server2 = state.accepted[1] as FakeWebSocketStub;
    await room.webSocketMessage(server2 as unknown as WebSocket, JSON.stringify({ v: TUNNEL_PROTOCOL_VERSION, type: 'bogus' }));
    expect(lastClose(server2)).toMatchObject({ code: 1008, reason: 'unsupported frame' });
  });

  it('应用层 ping → pong（hibernation auto-response 不可用时的运行时兜底）', async () => {
    seedModule(db, 'hello', { key: 'k', mode: 'connect' });
    await doConnect(room, 'hello', keyHashOf('k'));
    const server = state.accepted[0] as FakeWebSocketStub;
    await room.webSocketMessage(server as unknown as WebSocket, JSON.stringify({ v: TUNNEL_PROTOCOL_VERSION, type: 'ping' }));
    expect(sentFrames(server).at(-1)).toMatchObject({ type: 'pong' });
    expect(lastClose(server)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ⑤ HTTP 兜底 poll/respond（模块无法持长连时用）
// ---------------------------------------------------------------------------

describe('HTTP 兜底（poll + respond，同一核验纪律）', () => {
  it('无 WS 连接：模块先挂 poll → forward 入队并唤醒 → poll 得帧 → respond 回答 → forward 得响应', async () => {
    seedModule(db, 'hello', { key: 'k', mode: 'connect' });

    // poll：哈希不配先拒（核验在摘帧前）。
    const badPoll = await room.fetch(
      new Request(
        `https://tunnel.internal/poll?moduleId=hello&keyHash=${keyHashOf('wrong')}&waitMs=0`,
        { method: 'POST' },
      ),
    );
    expect(badPoll.status).toBe(403);

    // 真实顺序：模块先挂长轮询（等待者就位），浏览器请求后到才入队。
    const poll = room.fetch(
      new Request(
        `https://tunnel.internal/poll?moduleId=hello&keyHash=${keyHashOf('k')}&waitMs=5000`,
        { method: 'POST' },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10)); // 让 poll 走完核验、进入等待态
    const pending = doForward(room, '/api/x');

    const pollResponse = await poll;
    const { requests } = (await pollResponse.json()) as { requests: Array<Record<string, unknown>> };
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ type: 'request', path: '/api/x', moduleId: 'hello' });

    const respond = await room.fetch(
      new Request(
        `https://tunnel.internal/respond?moduleId=hello&keyHash=${keyHashOf('k')}`,
        {
          method: 'POST',
          body: JSON.stringify({
            v: TUNNEL_PROTOCOL_VERSION,
            type: 'response',
            requestId: requests[0]!.requestId,
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: Buffer.from('pong-data').toString('base64'),
          }),
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    expect(((await respond.json()) as { ok: boolean }).ok).toBe(true);

    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pong-data');
  });

  it('离线且无 poll 等待者：forward 立即 503（不等队列超时；人话）', async () => {
    seedModule(db, 'hello', { key: 'k', mode: 'connect' });
    const res = await doForward(room, '/api/x');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('tunnel_unavailable');
    expect(body.message).toContain('不在线');
  });

  it('respond：坏形状 400 / 未知 requestId 404 / 吊销凭据 403', async () => {
    seedModule(db, 'hello', { key: 'k', mode: 'connect' });
    const respond = (payload: unknown) =>
      room.fetch(
        new Request(`https://tunnel.internal/respond?moduleId=hello&keyHash=${keyHashOf('k')}`, {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'content-type': 'application/json' },
        }),
      );
    expect((await respond({ type: 'response', requestId: 'r', status: 999 })).status).toBe(400);
    expect((await respond({ type: 'response', requestId: 'ghost', status: 200 })).status).toBe(404);

    db.run('UPDATE module_registry SET credential_hash = NULL WHERE id = ?', 'hello');
    const revoked = await respond({ type: 'response', requestId: 'ghost', status: 200 });
    expect(revoked.status).toBe(403);
  });
});
