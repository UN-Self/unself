// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

import { ChannelRoom } from '../worker/src/do/ChannelRoom.js';
import {
  createChatDb,
  MemoryKv,
  TEST_VARS,
  type ChatTestDb,
  type ChatTestEnv,
} from './chat-test-factory';
import { FakeDoState, FakeWebSocketStub, installWebSocketTestShim, lastClose, sentFrames } from './ws-stub';

/** WS 运行时垫片（套件级常驻；vitest 每测试文件独立 worker，不污染兄弟套件）。 */
const restoreWebSocketRuntime = installWebSocketTestShim();
void restoreWebSocketRuntime;

/**
 * #217 WS token 续期（决策 #51 定案 C + 按消息重验）：
 * - JWT 经 ?token= 建连（verify → JIT → authorizeRoom → 101 ready，claims 随 meta 落 attachment）；
 * - {type:'token_refresh', token} 控制帧 → 当场验签+JIT+房间授权 → 原子换绑 + token_refreshed ack，
 *   旧 token 过期后消息帧仍可走（不断连）；无效 refresh → 1008；
 * - 按消息重验：旧 token 过期未 refresh / 行被停用 → 下一消息帧 1008。
 * 验签收口复用 worker/src/core-auth.js（与 HTTP 面同源）；DO 直驱（替运行时面，不替业务）。
 */

let db: ChatTestDb;
let env: ChatTestEnv;

beforeEach(() => {
  db = createChatDb();
  env = {
    DB: db.d1,
    SESSIONS: new MemoryKv(),
    ...TEST_VARS,
  };
});

type TokenFixture = {
  makeToken: (overrides?: Record<string, unknown>, expOffset?: number) => Promise<string>;
  signWithForeignKey: (overrides?: Record<string, unknown>) => Promise<string>;
};

/** 每个用例一把新 ES256 keypair + CORE_JWKS_JSON 注入（部署装配期同源形状）。 */
async function mintSetup(): Promise<TokenFixture> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  env.CORE_JWKS_JSON = JSON.stringify({
    keys: [{ ...publicJwk, kid, use: 'sig', alg: 'ES256' }],
  });

  const makeToken = async (
    overrides: Record<string, unknown> = {},
    expOffset?: number,
  ): Promise<string> => {
    const jwt = new SignJWT({ iss: 'unself-core', sub: 'u_ws', aud: 'chat', name: '阿巫', ...overrides })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuedAt();
    if (expOffset === undefined) {
      jwt.setExpirationTime('10m');
    } else {
      jwt.setExpirationTime(Math.floor(Date.now() / 1000) + expOffset);
    }
    return jwt.sign(pair.privateKey);
  };

  const foreign = await generateKeyPair('ES256', { extractable: true });
  const signWithForeignKey = async (overrides: Record<string, unknown> = {}): Promise<string> =>
    new SignJWT({ iss: 'unself-core', sub: 'u_ws', aud: 'chat', name: '阿巫', ...overrides })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(foreign.privateKey as unknown as CryptoKey);

  return { makeToken, signWithForeignKey };
}

/** 建连驱动：room.fetch(/connect) 直通真类；替身 pair.server 即 DO 侧 socket（真运行时接线语义）。 */
async function connect(
  room: ChannelRoom,
  token: string,
): Promise<{ server: FakeWebSocketStub }> {
  const request = new Request(
    `https://internal/connect?kind=public&id=1&token=${encodeURIComponent(token)}`,
    { headers: { upgrade: 'websocket' } },
  );
  const response = await room.fetch(request);
  expect(response.status).toBe(101);

  // 真运行时把 pair.server 交给 state.acceptWebSocket；替身里由 FakeDoState 收集，取最后一个。
  const state = room.state as unknown as { accepted: FakeWebSocketStub[] };
  const server = state.accepted.at(-1) as FakeWebSocketStub;
  expect(server).toBeDefined();
  return { server };
}

/** 消息帧驱动（webSocketMessage 第一参即 server socket 本身）。 */
function frame(room: ChannelRoom, server: FakeWebSocketStub, payload: unknown): Promise<void> {
  return room.webSocketMessage(server, JSON.stringify(payload)) as Promise<void>;
}

/** 经 DO 提交一条消息（HTTP 内部通道），换取落库消息行数基线。 */
function messageCount(): number {
  return db.query<{ n: number }>('SELECT COUNT(*) AS n FROM messages')[0]!.n;
}

describe('chat WS 鉴权与 token 续期（#217 定案 C）', () => {
  it('有效 token 建连 → 101、ready 帧、meta（userId + claims）落 attachment', async () => {
    const { makeToken } = await mintSetup();
    const room = new ChannelRoom(new FakeDoState() as never, env as never);
    const token = await makeToken({ sub: 'u_ws1' });

    const { server } = await connect(room, token);

    const ready = sentFrames(server)[0]!;
    expect(ready.type).toBe('ready');
    expect((ready.room as Record<string, unknown>).name).toBe('general');

    const meta = server.deserializeAttachment() as {
      principal: { userId: number; claims: { sub: string } };
      room: { id: number; kind: string };
    };
    expect(meta.principal.claims.sub).toBe('u_ws1');
    expect(meta.principal.userId).toBe(
      db.first<{ id: number }>('SELECT id FROM users WHERE username = ?', 'core:u_ws1')!.id,
    );
    expect(meta.room).toMatchObject({ id: 1, kind: 'public' });
  });

  it('无效 token（错签）→ 建连 401；非成员 → 403', async () => {
    const { makeToken, signWithForeignKey } = await mintSetup();
    const room = new ChannelRoom(new FakeDoState() as never, env as never);

    const bad = await room.fetch(
      new Request(`https://internal/connect?kind=public&id=1&token=${await signWithForeignKey()}`, {
        headers: { upgrade: 'websocket' },
      }),
    );
    expect(bad.status).toBe(401);

    // 房间 2 不存在/非成员（JIT 用户只入 general）→ 403
    const forbidden = await room.fetch(
      new Request(`https://internal/connect?kind=public&id=2&token=${await makeToken()}`, {
        headers: { upgrade: 'websocket' },
      }),
    );
    expect(forbidden.status).toBe(403);
  });

  it('token_refresh 带新有效 token → ack token_refreshed + 换绑生效：旧 claims 过期后消息帧仍可走', async () => {
    const { makeToken } = await mintSetup();
    const room = new ChannelRoom(new FakeDoState() as never, env as never);

    // 旧 token 2 秒后过期（宽限度极短，模拟快到期）
    const oldToken = await makeToken({ sub: 'u_r1' }, 2);
    const { server } = await connect(room, oldToken);
    expect(sentFrames(server)[0]!.type).toBe('ready');

    const newToken = await makeToken({ sub: 'u_r1' }, 600);
    await frame(room, server, { type: 'token_refresh', token: newToken });

    const frames = sentFrames(server);
    expect(frames[1]).toMatchObject({ protocolVersion: 1, type: 'token_refreshed' });
    expect(server.closed).toHaveLength(0);

    // 换绑生效：等待旧 token 自然过期后，消息帧仍走通（若仍绑旧 claims，按消息重验会 1008）
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const before = messageCount();
    await frame(room, server, { type: 'send', content: '续期后仍可发' });
    expect(lastClose(server)).toBeUndefined();
    expect(messageCount()).toBe(before + 1);

    const meta = server.deserializeAttachment() as {
      principal: { claims: { exp: number } };
    };
    expect(meta.principal.claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('token_refresh 带错签 / 过期 / 错 aud token → close(1008)', async () => {
    const { makeToken, signWithForeignKey } = await mintSetup();

    const cases: Array<[string, Promise<string>]> = [
      ['wrong-signature', signWithForeignKey()],
      ['expired', makeToken({ sub: 'u_x' }, -10)],
      ['wrong-aud', makeToken({ sub: 'u_x', aud: 'other-module' })],
    ];
    for (const [name, tokenPromise] of cases) {
      const fresh = new ChannelRoom(new FakeDoState() as never, env as never);
      const { server } = await connect(fresh, await makeToken({ sub: 'u_x' }));
      await frame(fresh, server, { type: 'token_refresh', token: await tokenPromise });
      const close = lastClose(server);
      expect(close?.code, name).toBe(1008);
      expect(close?.reason, name).toBe('Unauthorized');
    }
  });

  it('旧 token 正常但行被停用 → 下一消息帧 close(1008)（停用踢出=按消息重验）', async () => {
    const { makeToken } = await mintSetup();
    const room = new ChannelRoom(new FakeDoState() as never, env as never);
    const { server } = await connect(room, await makeToken({ sub: 'u_ban' }));

    db.run('UPDATE users SET is_disabled = 1 WHERE username = ?', 'core:u_ban');

    await frame(room, server, { type: 'send', content: '被踢前最后一句话' });
    expect(lastClose(server)?.code).toBe(1008);
    expect(messageCount()).toBe(0);
  });

  it('旧 claims 过期未 refresh → 下一消息帧 close(1008)', async () => {
    const { makeToken } = await mintSetup();
    const room = new ChannelRoom(new FakeDoState() as never, env as never);
    const { server } = await connect(room, await makeToken({ sub: 'u_stale' }, 1));

    await new Promise((resolve) => setTimeout(resolve, 1500));
    await frame(room, server, { type: 'send', content: '过期后补发' });
    expect(lastClose(server)?.code).toBe(1008);
    expect(messageCount()).toBe(0);
  });
});
