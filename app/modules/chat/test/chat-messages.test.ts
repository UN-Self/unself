// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';

import { app, setEnv } from './worker-app';
import { installRoomDo } from './do-stub';
import {
  createChatDb,
  MemoryKv,
  TEST_VARS,
  type ChatTestDb,
  type ChatTestEnv,
} from './chat-test-factory';

/**
 * 消息收发主链路（真库集成，路由级 app.request）：
 * mint core 形状 token（#217：认证走模块 JWT 验签 + JIT 建档，本地登录已裁）→ bootstrap → 发消息 → 读回。
 * 覆盖：general 频道种子触发器、消息内容/发送者/分页、private 频道 403、未带 token 401。
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
  // v1 提交面经 DO 桥：把真 ChannelRoom 类接进 env（替 workers 运行时，不替业务）
  installRoomDo(env as unknown as Record<string, unknown>);
  setEnv(env);
});

/** 每用例一把新 ES256 keypair + CORE_JWKS_JSON 注入；回 token 造函数（#217 认证，签发形状同 core）。 */
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

/** bootstrap：确保 general 存在且当前用户入席，回当前可见频道。 */
async function bootstrap(
  token: string,
): Promise<{ channels: Array<{ id: number; name: string; isMember?: boolean }> }> {
  const res = await app.request('https://chat.example/api/bootstrap', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { channels: Array<{ id: number; name: string; isMember?: boolean }> };
}

/** POST /api/v1/rooms/public/1/messages（HTTP 提交面；经 DO 桥，真 ChannelRoom 持久化）。 */
async function postMessage(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request('https://chat.example/api/v1/rooms/public/1/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientMessageId: crypto.randomUUID(), ...body }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

interface Sender {
  kind: string;
  id: number;
  username: string;
  displayName: string;
}

interface Message {
  id: number;
  content: string;
  createdAt: string;
  sender: Sender;
}

/** GET /api/messages（读面）。 */
async function listMessages(
  token: string,
  query: string,
): Promise<{ status: number; messages: Message[] }> {
  const res = await app.request(`https://chat.example/api/messages?kind=public&roomId=1${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { messages?: Message[] };
  return { status: res.status, messages: body.messages ?? [] };
}

describe('chat 消息收发主链路（真库集成）', () => {
  it('建档 → bootstrap 保证 general 频道 → 发消息 → 读回内容/发送者真值一致', async () => {
    const makeToken = await mintSetup();
    const token = await makeToken({ sub: 'u_admin', name: '管理员' });

    // bootstrap：general 频道种子触发器应保证全新库也有频道且用户已入席
    const boot = await bootstrap(token);
    const general = boot.channels.find((channel) => channel.name === 'general');
    expect(general).toBeDefined();
    expect(general!.id).toBe(1);
    expect(general!.isMember).toBe(true);

    // 发消息（kind=public，roomId=general）
    const sent = await postMessage(token, { content: '第一条消息' });
    expect(sent.status).toBe(200);
    expect(sent.json.created).toBe(true);
    const message = sent.json.message as Message;
    expect(message.content).toBe('第一条消息'); // 返回给调用方的是明文
    expect(message.sender.username).toBe('core:u_admin');
    expect(message.sender.displayName).toBe('管理员');

    // 落库的是密文（直查真库）：明文与密文不同、明文不出现在存储层
    const row = db.first<{ content: string }>('SELECT content FROM messages WHERE id = ?', message.id);
    expect(row).not.toBeNull();
    expect(row!.content).not.toBe('第一条消息');
    expect(row!.content.includes('第一条消息')).toBe(false);

    // 读回：内容/发送者真值一致（解密链路走通）
    const list = await listMessages(token, '');
    expect(list.status).toBe(200);
    const mine = list.messages.find((item) => item.id === message.id);
    expect(mine).toBeDefined();
    expect(mine!.content).toBe('第一条消息');
    expect(mine!.sender.username).toBe('core:u_admin');
  });

  it('分页：limit=1 只回最新 1 条（不回更早那条），before 翻页可读到旧消息', async () => {
    const makeToken = await mintSetup();
    const token = await makeToken({ sub: 'u_admin', name: '管理员' });
    await bootstrap(token);

    const ids: number[] = [];
    for (const content of ['第一页旧消息', '第二页新消息']) {
      const sent = await postMessage(token, { content });
      expect(sent.status).toBe(200);
      ids.push((sent.json.message as Message).id);
    }

    // 最新一页：limit=1 → 只有最新那条
    const page1 = await listMessages(token, '&limit=1');
    expect(page1.messages).toHaveLength(1);
    expect(page1.messages[0]!.content).toBe('第二页新消息');

    // before 翻页：跳过最新 → 读到旧的
    const page2 = await listMessages(token, `&limit=1&before=${ids[1]}`);
    expect(page2.messages).toHaveLength(1);
    expect(page2.messages[0]!.content).toBe('第一页旧消息');
  });

  it('非成员读 private 频道消息 → 403（权限只信服务端成员关系判定）', async () => {
    const makeToken = await mintSetup();

    // admin 建 private 频道（自己成为 owner）
    const adminToken = await makeToken({ sub: 'u_admin', name: '管理员' });
    await bootstrap(adminToken);
    const created = await app.request('https://chat.example/api/channels', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '密谈', kind: 'private' }),
    });
    expect(created.status).toBe(200);
    const channelId = ((await created.json()) as { channel: { id: number } }).channel.id;

    // admin（owner）可读
    const ownerView = await app.request(
      `https://chat.example/api/messages?kind=private&roomId=${channelId}`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(ownerView.status).toBe(200);

    // bob（非成员）→ 403
    const bobToken = await makeToken({ sub: 'u_bob', name: '阿鲍' });
    const forbidden = await app.request(
      `https://chat.example/api/messages?kind=private&roomId=${channelId}`,
      { headers: { authorization: `Bearer ${bobToken}` } },
    );
    expect(forbidden.status).toBe(403);
  });

  it('未带 token 访问 bootstrap / messages → 401', async () => {
    await mintSetup();
    const boot = await app.request('https://chat.example/api/bootstrap');
    expect(boot.status).toBe(401);
    const list = await app.request('https://chat.example/api/messages?kind=public&roomId=1');
    expect(list.status).toBe(401);
  });
});
