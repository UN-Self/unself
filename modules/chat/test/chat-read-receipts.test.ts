// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';

import { ChannelRoom } from '../worker/src/do/ChannelRoom.js';
import { app, setEnv } from './worker-app';
import { installRoomDo } from './do-stub';
import {
  createChatDb,
  MemoryKv,
  TEST_VARS,
  type ChatTestDb,
  type ChatTestEnv,
} from './chat-test-factory';
import { FakeDoState, FakeWebSocketStub, installWebSocketTestShim, sentFrames } from './ws-stub';

/**
 * #220 已读回执（flows.md 链路 2 落地）：
 * - 上报：POST /api/messages/read 批量 {kind, roomId, messageIds}——幂等（INSERT OR IGNORE +
 *   批内去重）、未入房成员 403、>200 批 413、旧 messageId 单值字段兼容；
 * - 推送：ChannelRoom /receipts 内部路由——实际新增行>0 才聚合广播，幂等重放=零事件；
 * - 补拉：GET /api/messages 每条消息富化 readReceipts {count, readBy[]}，
 *   口径=发件人恒已读不计分母、停用/已删成员不计（分母=可达收件人）；
 * - DO 兜底快照：/receipts/snapshot 最新 30 条聚合（json_object 键 userId/readAt 与帧同形）。
 * 真库（schema-baseline.sql 真建表）+ 真 ChannelRoom 类（ws-stub 替运行时面，不替业务）。
 */

/** WS 运行时垫片（套件级常驻；vitest 每测试文件独立 worker，不污染兄弟套件）。 */
const restoreWebSocketRuntime = installWebSocketTestShim();
void restoreWebSocketRuntime;

let db: ChatTestDb;
let env: ChatTestEnv;

beforeEach(() => {
  db = createChatDb();
  env = {
    DB: db.d1,
    SESSIONS: new MemoryKv(),
    ...TEST_VARS,
  };
  // v1 提交/回执面经 DO 桥：把真 ChannelRoom 类接进 env（替 workers 运行时，不替业务）
  installRoomDo(env as unknown as Record<string, unknown>);
  setEnv(env);
});

/** 每用例一把新 ES256 keypair + CORE_JWKS_JSON 注入；回 token 造函数（#217 认证形状）。 */
async function mintSetup(): Promise<(overrides?: Record<string, unknown>) => Promise<string>> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  env.CORE_JWKS_JSON = JSON.stringify({
    keys: [{ ...publicJwk, kid, use: 'sig', alg: 'ES256' }],
  });

  return (overrides: Record<string, unknown> = {}) =>
    new SignJWT({ iss: 'unself-core', sub: 'u_1', aud: 'chat', name: '黄一', ...overrides })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(pair.privateKey);
}

/** 造一个已入 general（id=1）的用户（JIT 首访即入席），回 userId。 */
async function joinGeneral(sub: string, name: string): Promise<number> {
  const token = await makeToken({ sub, name });
  const res = await app.request('https://chat.example/api/bootstrap', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const userId = db.first<{ id: number }>('SELECT id FROM users WHERE username = ?', `core:${sub}`)!.id;
  return userId;
}

/** 种子用户直插（不经 JIT；db.run 形状参照 chat-do-submit），回 id。 */
function seedUser(username: string): number {
  db.run(
    `INSERT INTO users (username, display_name, password_hash, password_salt, is_admin)
     VALUES (?, ?, 'x', 'y', 0)`,
    username,
    username,
  );
  return db.first<{ id: number }>('SELECT id FROM users WHERE username = ?', username)!.id;
}

let makeToken: (overrides?: Record<string, unknown>) => Promise<string>;

/** 手建频道 + 成员入席（频道 1 名为 general 由种子保证；其余频道测试自建）。 */
function seedChannel(kind: 'public' | 'private' | 'dm', name: string, memberIds: number[]): number {
  db.run(
    `INSERT INTO channels (name, description, kind, created_by) VALUES (?, '', ?, NULL)`,
    name,
    kind,
  );
  const channelId = db.first<{ id: number }>('SELECT id FROM channels WHERE name = ?', name)!.id;
  for (const userId of memberIds) {
    db.run(
      `INSERT OR IGNORE INTO channel_members (channel_id, user_id, role) VALUES (?, ?, 'member')`,
      channelId,
      userId,
    );
  }
  return channelId;
}

/** A 经 JIT 建档后用 v1 提交面发一条消息，回 messageId（走真 ChannelRoom /client-action）。 */
async function sendMessage(sub: string, name: string, kind: 'public' | 'private' | 'dm', roomId: number): Promise<number> {
  const token = await makeToken({ sub, name });
  const res = await app.request(`https://chat.example/api/v1/rooms/${kind}/${roomId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: `来自 ${sub}`, clientMessageId: crypto.randomUUID() }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { message?: { id: number } };
  return body.message!.id;
}

/** 批量已读上报。 */
async function reportRead(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: { ok?: boolean; receipts?: Array<{ messageId: number; readAt: string }>; lastReadMessageId?: number; error?: string } }> {
  const res = await app.request('https://chat.example/api/messages/read', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as never };
}

/** 读回消息分页（GET /api/messages），断言富化形状。 */
async function listMessages(
  token: string,
  kind: string,
  roomId: number,
): Promise<{ status: number; messages: Array<{ id: number; readReceipts?: { count: number; total: number; readBy: Array<{ userId: number; username: string; displayName: string; readAt: string }> } }> }> {
  const res = await app.request(`https://chat.example/api/messages?kind=${kind}&roomId=${roomId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { messages?: Array<never> };
  return { status: res.status, messages: (body.messages ?? []) as never };
}

/** DO verified internal 头（形状抄 chat-do-submit）。 */
function verifiedHeaders(userId: number): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-cfchat-internal-auth': 'worker-verified',
    'x-cfchat-verified-user-id': String(userId),
    'x-cfchat-verified-is-admin': '0',
    'x-cfchat-verified-at': String(Date.now()),
  };
}

describe('chat 已读回执（#220：上报/幂等/口径/推送/兜底）', () => {
  it('上报正例：成员批量上报回 receipts 含 readAt，行真落库（db.query 直查）', async () => {
    const mint = await mintSetup();
    makeToken = mint;
    const aliceId = await joinGeneral('u_alice', '爱丽丝');
    const messageId = await sendMessage('u_alice', '爱丽丝', 'public', 1);

    const bobId = await joinGeneral('u_bob', '阿鲍');
    const bobToken = await makeToken({ sub: 'u_bob', name: '阿鲍' });
    const { status, json } = await reportRead(bobToken, {
      kind: 'public',
      roomId: 1,
      messageIds: [messageId],
    });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.receipts).toHaveLength(1);
    expect(json.receipts![0]!.messageId).toBe(messageId);
    expect(typeof json.receipts![0]!.readAt).toBe('string');
    expect(json.receipts![0]!.readAt.length).toBeGreaterThan(0);

    // 行真落库：message_id + user_id 主键行存在（直查真库，不经适配器）
    const row = db.first<{ message_id: number; user_id: number; read_at: string }>(
      'SELECT message_id, user_id, read_at FROM read_receipts WHERE message_id = ? AND user_id = ?',
      messageId,
      bobId,
    );
    expect(row).not.toBeNull();
    expect(row!.read_at).toBe(json.receipts![0]!.readAt);
    void aliceId;
  });

  it('幂等：同批重放 → 零新增行、DO 零广播事件（第二个 socket 收不到第二帧）', async () => {
    const mint = await mintSetup();
    makeToken = mint;
    await joinGeneral('u_alice', '爱丽丝');
    const messageId = await sendMessage('u_alice', '爱丽丝', 'public', 1);
    const bobId = await joinGeneral('u_bob', '阿鲍');
    const bobToken = await makeToken({ sub: 'u_bob', name: '阿鲍' });

    // DO 实例常驻 + socket 常驻（观察整个广播面：HTTP 面 + 内部 /receipts 面）
    const state = new FakeDoState();
    const room = new ChannelRoom(state, env as never);
    (env as unknown as Record<string, unknown>).CHANNEL_ROOM = {
      idFromName: (_name: string) => 'room',
      get: () => ({ fetch: (input: string | Request, init?: RequestInit) => room.fetch(input instanceof Request ? input : new Request(input, init)) }),
    };
    const socket = new FakeWebSocketStub();
    room.connections.set(socket, {
      principal: { userId: bobId, isAdmin: false, claims: { exp: Math.floor(Date.now() / 1000) + 600, iss: 'unself-core', sub: 'u_bob' } },
      room: { id: 1, kind: 'public', name: 'general' },
    });

    const first = await reportRead(bobToken, { kind: 'public', roomId: 1, messageIds: [messageId] });
    expect(first.status).toBe(200);
    expect(first.json.receipts).toHaveLength(1);
    expect(socket.sent).toHaveLength(1); // 新增>0 → 一帧聚合广播

    // 同批重放：零新增行、零事件（验收锚点）
    const replay = await reportRead(bobToken, { kind: 'public', roomId: 1, messageIds: [messageId] });
    expect(replay.status).toBe(200);
    expect(replay.json.receipts).toHaveLength(0);
    expect(socket.sent).toHaveLength(1); // 第二个 socket（同一连接）收不到第二帧

    const rows = db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM read_receipts WHERE message_id = ? AND user_id = ?',
      messageId,
      bobId,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('负例：未入房成员上报 private 频道 → 403；批 >200 → 413', async () => {
    const mint = await mintSetup();
    makeToken = mint;
    const ownerId = await joinGeneral('u_owner', '群主');
    const privateId = seedChannel('private', '密谈220', [ownerId]);

    // outsider 是 general 成员但不在 private 频道
    const outsiderToken = await makeToken({ sub: 'u_out', name: '外人' });
    const noMembership = await reportRead(outsiderToken, {
      kind: 'private',
      roomId: privateId,
      messageIds: [1],
    });
    expect(noMembership.status).toBe(403);

    // 超大批量 → 413（201 个正整数）
    await joinGeneral('u_alice', '爱丽丝');
    const aliceToken = await makeToken({ sub: 'u_alice', name: '爱丽丝' });
    const tooMany = await reportRead(aliceToken, {
      kind: 'public',
      roomId: 1,
      messageIds: Array.from({ length: 201 }, (_, i) => i + 1),
    });
    expect(tooMany.status).toBe(413);
  });

  it('口径（单聊）：发件人恒已读不计分母——B 已读后 readReceipts={count:1, readBy:[B]}', async () => {
    const mint = await mintSetup();
    makeToken = mint;
    const aliceId = await joinGeneral('u_alice', '爱丽丝');
    const bobId = await joinGeneral('u_bob', '阿鲍');

    // 单聊：A↔B
    const dmId = seedChannel('dm', 'dm220', [aliceId, bobId]);
    const messageId = await sendMessage('u_alice', '爱丽丝', 'dm', dmId);

    // B 读后上报
    const bobToken = await makeToken({ sub: 'u_bob', name: '阿鲍' });
    const reported = await reportRead(bobToken, { kind: 'dm', roomId: dmId, messageIds: [messageId] });
    expect(reported.status).toBe(200);

    // A 视角读回：count=1（只有 B），readBy=[B]；分母=1（B；A 自己恒已读不计）
    const aliceToken = await makeToken({ sub: 'u_alice', name: '爱丽丝' });
    const { messages } = await listMessages(aliceToken, 'dm', dmId);
    const mine = messages.find((m) => m.id === messageId)!;
    expect(mine.readReceipts).toBeDefined();
    expect(mine.readReceipts!.count).toBe(1);
    expect(mine.readReceipts!.readBy).toHaveLength(1);
    expect(mine.readReceipts!.readBy[0]!.userId).toBe(bobId);
    expect(mine.readReceipts!.readBy[0]!.username).toBe('core:u_bob');
    // 单聊直接 ✓✓ 的依据：count === 分母（total=1，只含对方）
    expect(mine.readReceipts!.total).toBe(1);
    expect(mine.readReceipts!.count).toBe(mine.readReceipts!.total);
  });

  it('口径（群聊）：A 发言 B/C 已读 → count=2（分母=B/C，不含发件人 A；而非 3）', async () => {
    const mint = await mintSetup();
    makeToken = mint;
    await joinGeneral('u_alice', '爱丽丝');
    const bobId = await joinGeneral('u_bob', '阿鲍');
    const carolId = await joinGeneral('u_carol', '卡罗');
    const messageId = await sendMessage('u_alice', '爱丽丝', 'public', 1);

    const bobToken = await makeToken({ sub: 'u_bob', name: '阿鲍' });
    const carolToken = await makeToken({ sub: 'u_carol', name: '卡罗' });
    expect((await reportRead(bobToken, { kind: 'public', roomId: 1, messageIds: [messageId] })).status).toBe(200);
    expect((await reportRead(carolToken, { kind: 'public', roomId: 1, messageIds: [messageId] })).status).toBe(200);

    // A 视角：count=2 而非 3
    const aliceToken = await makeToken({ sub: 'u_alice', name: '爱丽丝' });
    const { messages } = await listMessages(aliceToken, 'public', 1);
    const mine = messages.find((m) => m.id === messageId)!;
    expect(mine.readReceipts!.count).toBe(2);
    expect(mine.readReceipts!.total).toBe(2);
    expect(mine.readReceipts!.readBy.map((r) => r.userId).sort()).toEqual([bobId, carolId].sort());
  });

  it('口径：停用成员不计分母（is_disabled=1 或 disabled_until 未来）', async () => {
    const mint = await mintSetup();
    makeToken = mint;
    await joinGeneral('u_alice', '爱丽丝');
    const bobId = await joinGeneral('u_bob', '阿鲍');
    const daveId = await joinGeneral('u_dave', '老王');
    const messageId = await sendMessage('u_alice', '爱丽丝', 'public', 1);

    // dave 永久停用；bob 临时停用到未来（都不可达，不计分母）
    db.run('UPDATE users SET is_disabled = 1 WHERE id = ?', daveId);
    db.run(
      "UPDATE users SET disabled_until = datetime('now', '+1 hour') WHERE id = ?",
      bobId,
    );

    const aliceToken = await makeToken({ sub: 'u_alice', name: '爱丽丝' });
    // 读面本身可达（读操作者 alice 不受影响）；分母=0（B/D 都停用）
    const { messages } = await listMessages(aliceToken, 'public', 1);
    const mine = messages.find((m) => m.id === messageId)!;
    expect(mine.readReceipts!.count).toBe(0);
    void bobId;
  });

  it('跨房防护：把 general 的消息上报到别的房间 → 403/零写入', async () => {
    const mint = await mintSetup();
    makeToken = mint;
    await joinGeneral('u_alice', '爱丽丝');
    const messageId = await sendMessage('u_alice', '爱丽丝', 'public', 1);
    const bobId = await joinGeneral('u_bob', '阿鲍');

    // bob 自建 private 频道（是成员），把 general 的消息 id 上报到该频道
    const privateId = seedChannel('private', '别家220', [bobId]);
    const bobToken = await makeToken({ sub: 'u_bob', name: '阿鲍' });
    const result = await reportRead(bobToken, { kind: 'private', roomId: privateId, messageIds: [messageId] });

    // 权限面过了（是成员），但消息不属于该频道 → 不落行（recordReadReceipts 房间过滤）
    expect(result.status).toBe(200);
    expect(result.json.receipts).toHaveLength(0);
    const rows = db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM read_receipts WHERE message_id = ? AND user_id = ?',
      messageId,
      bobId,
    );
    expect(rows[0]!.n).toBe(0);
  });

  describe('DO /receipts 内部路由（真 ChannelRoom + ws-stub）', () => {
    it('正例：verified internal 上报 → 广播帧形状 {type:read_receipts, messageId 最大, userId, readAt, messageIds}', async () => {
      const mint = await mintSetup();
      makeToken = mint;
      await joinGeneral('u_alice', '爱丽丝');
      const idA = await sendMessage('u_alice', '爱丽丝', 'public', 1);
      const idB = await sendMessage('u_alice', '爱丽丝', 'public', 1);
      const bobId = await joinGeneral('u_bob', '阿鲍');

      const room = new ChannelRoom(new FakeDoState(), env as never);
      const socket = new FakeWebSocketStub();
      room.connections.set(socket, {
        principal: { userId: bobId, isAdmin: false, claims: { exp: Math.floor(Date.now() / 1000) + 600, iss: 'unself-core', sub: 'u_bob' } },
        room: { id: 1, kind: 'public', name: 'general' },
      });

      const request = new Request('https://internal/receipts', {
        method: 'POST',
        headers: verifiedHeaders(bobId),
        body: JSON.stringify({ room: { kind: 'public', id: 1 }, messageIds: [idA, idB] }),
      });
      const response = await room.fetch(request);
      expect(response.status).toBe(200);

      const frames = sentFrames(socket);
      expect(frames).toHaveLength(1); // 聚合成一帧
      const frame = frames[0]!;
      expect(frame.protocolVersion).toBe(1);
      expect(frame.type).toBe('read_receipts');
      expect(frame.messageId).toBe(Math.max(idA, idB));
      expect(frame.userId).toBe(bobId);
      expect(typeof frame.readAt).toBe('string');
      expect(frame.messageIds).toEqual([idA, idB].sort((x, y) => x - y));

      // 非内部请求 → 401
      const noHeaders = await room.fetch(new Request('https://internal/receipts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: { kind: 'public', id: 1 }, messageIds: [idA] }),
      }));
      expect(noHeaders.status).toBe(401);
    });

    it('幂等重放：同批再发 /receipts → 零新增行零事件（broadcast:false）', async () => {
      const mint = await mintSetup();
      makeToken = mint;
      await joinGeneral('u_alice', '爱丽丝');
      const messageId = await sendMessage('u_alice', '爱丽丝', 'public', 1);
      const bobId = await joinGeneral('u_bob', '阿鲍');

      const room = new ChannelRoom(new FakeDoState(), env as never);
      const socket = new FakeWebSocketStub();
      room.connections.set(socket, {
        principal: { userId: bobId, isAdmin: false, claims: { exp: Math.floor(Date.now() / 1000) + 600, iss: 'unself-core', sub: 'u_bob' } },
        room: { id: 1, kind: 'public', name: 'general' },
      });

      const makeRequest = () => new Request('https://internal/receipts', {
        method: 'POST',
        headers: verifiedHeaders(bobId),
        body: JSON.stringify({ room: { kind: 'public', id: 1 }, messageIds: [messageId] }),
      });

      const first = await room.fetch(makeRequest());
      expect(((await first.json()) as { broadcast: boolean }).broadcast).toBe(true);
      expect(socket.sent).toHaveLength(1);

      const replay = await room.fetch(makeRequest());
      const replayBody = (await replay.json()) as { broadcast: boolean; receipts: unknown[] };
      expect(replayBody.broadcast).toBe(false);
      expect(replayBody.receipts).toHaveLength(0);
      expect(socket.sent).toHaveLength(1); // 零事件
    });

    it('兜底快照：GET /receipts/snapshot → 最新30条聚合，json_object 键 userId/readAt 与帧同形', async () => {
      const mint = await mintSetup();
      makeToken = mint;
      await joinGeneral('u_alice', '爱丽丝');
      const messageId = await sendMessage('u_alice', '爱丽丝', 'public', 1);
      const bobId = await joinGeneral('u_bob', '阿鲍');

      const room = new ChannelRoom(new FakeDoState(), env as never);
      const response = await room.fetch(new Request(`https://internal/receipts/snapshot?roomId=1`, {
        headers: { 'x-cfchat-internal-auth': 'worker-verified' },
      }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        receipts: Array<{ messageId: number; readCount: number; readBy: Array<{ userId: number; readAt: string }> }>;
      };
      const target = body.receipts.find((r) => r.messageId === messageId)!;
      expect(target).toBeDefined();

      // bob 上报后快照聚合出真实行（键名 userId/readAt 与广播帧同形）
      db.run('INSERT OR IGNORE INTO read_receipts (message_id, user_id) VALUES (?, ?)', messageId, bobId);
      const after = await room.fetch(new Request(`https://internal/receipts/snapshot?roomId=1`, {
        headers: { 'x-cfchat-internal-auth': 'worker-verified' },
      }));
      const afterBody = (await after.json()) as typeof body;
      const targetAfter = afterBody.receipts.find((r) => r.messageId === messageId)!;
      expect(targetAfter.readCount).toBe(1);
      expect(targetAfter.readBy).toEqual([{ userId: bobId, readAt: targetAfter.readBy[0]!.readAt }]);
    });

    it('非成员 /receipts → 403 forbidden（authorizeRoom 校验）', async () => {
      const mint = await mintSetup();
      makeToken = mint;
      const ownerId = await joinGeneral('u_owner', '群主');
      const privateId = seedChannel('private', '密谈快照', [ownerId]);
      await joinGeneral('u_alice', '爱丽丝');
      const outsiderId = db.first<{ id: number }>('SELECT id FROM users WHERE username = ?', 'core:u_out')?.id
        ?? seedUser('placeholder');

      // outsider（非 private 成员）直打 DO 内部路由
      const room = new ChannelRoom(new FakeDoState(), env as never);
      const response = await room.fetch(new Request('https://internal/receipts', {
        method: 'POST',
        headers: verifiedHeaders(outsiderId),
        body: JSON.stringify({ room: { kind: 'private', id: privateId }, messageIds: [1] }),
      }));
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('forbidden');
    });
  });
});

describe('chat 已读回执服务端兜底（#229：发件人自读恒不计）', () => {
  it('发件人上报自己的消息：HTTP 200 但零落行、零广播（决策 #52 口径的强制面）', async () => {
    const mint = await mintSetup();
    makeToken = mint;
    const aliceId = await joinGeneral('u_alice229', '爱丽丝');
    const bobId = await joinGeneral('u_bob229', '阿鲍');
    const messageId = await sendMessage('u_alice229', '爱丽丝', 'public', 1);

    // 发件人本人上报自己的消息（正常客户端不会发，但客户端缺陷——如 #229 的 myUserId=0——会发）
    const { status, json } = await reportRead(await makeToken({ sub: 'u_alice229', name: '爱丽丝' }), {
      kind: 'public',
      roomId: 1,
      messageIds: [messageId],
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.receipts).toHaveLength(0); // 自读零新增 → 零广播素材

    // 库里只有「阿鲍后来读」的行；甲的自读行不存在
    const row = db.first<{ user_id: number }>(
      'SELECT user_id FROM read_receipts WHERE message_id = ? AND user_id = ?',
      messageId,
      aliceId,
    );
    expect(row).toBeNull();
    void bobId;
  });

  it('对照组：同一批里他人消息正常落行，发件人自己的消息被跳过（过滤只作用于自读）', async () => {
    const mint = await mintSetup();
    makeToken = mint;
    const aliceId = await joinGeneral('u_alice229b', '爱丽丝');
    void aliceId;
    await joinGeneral('u_bob229b', '阿鲍');
    const myMsg = await sendMessage('u_alice229b', '爱丽丝', 'public', 1);
    const bobMsg = await sendMessage('u_bob229b', '阿鲍', 'public', 1);

    // 爱丽丝上报「自己的 + 鲍勃的」两条（客户端分母失真场景的修复面）
    const { status, json } = await reportRead(await makeToken({ sub: 'u_alice229b', name: '爱丽丝' }), {
      kind: 'public',
      roomId: 1,
      messageIds: [myMsg, bobMsg],
    });
    expect(status).toBe(200);
    expect(json.receipts?.map((r) => r.messageId)).toEqual([bobMsg]); // 只剩鲍勃的

    const mine = db.first<{ user_id: number }>(
      'SELECT user_id FROM read_receipts WHERE message_id = ? AND user_id = ?',
      myMsg,
      aliceId,
    );
    expect(mine).toBeNull();
  });
});
