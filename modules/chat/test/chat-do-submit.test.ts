// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';

import { ChannelRoom } from '../worker/src/do/ChannelRoom.js';
import { createChatDb, MemoryKv, TEST_VARS } from './chat-test-factory';

/**
 * v1 HTTP 消息提交（走真 ChannelRoom /client-action 面的提交逻辑）：
 * 直接实例化 DO 类（env/state 注入），HTTP 入口到 DO 的桥接由 T4 的装配面验证。
 */
function makeEnv() {
  const db = createChatDb();
  return {
    env: {
      DB: db.d1,
      SESSIONS: new MemoryKv(),
      ...TEST_VARS,
    },
    db,
  };
}

function makeState() {
  return {
    storage: {
      async get(_key: string) {
        return undefined;
      },
      async set(_key: string, _value: unknown) {},
      async delete(_key: string) {},
      async getAlarm() {
        return undefined;
      },
      async setAlarm(_time: number) {},
      async list() {
        return new Map();
      },
    },
    waitUntil: (_promise: Promise<unknown>) => {},
    getWebSockets: () => [],
    acceptWebSocket: (_socket: unknown) => {},
  };
}

function verifiedHeaders(userId: string, isAdmin: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-cfchat-internal-auth': 'worker-verified',
    'x-cfchat-verified-user-id': userId,
    'x-cfchat-verified-is-admin': isAdmin,
    'x-cfchat-verified-at': String(Date.now()),
  };
}

describe('ChannelRoom 提交面（真库 + 真 DO 类）', () => {
  it('/client-action send：非内部请求 → 401', async () => {
    const { env } = makeEnv();
    const room = new ChannelRoom(makeState(), env);

    const request = new Request('https://internal/client-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: { kind: 'public', id: 1 }, action: { type: 'send', content: 'hi' } }),
    });
    const response = await room.fetch(request);
    expect(response.status).toBe(401);
  });

  it('/client-action send：带验证头 + 种子用户/成员 → 落库且回明文消息', async () => {
    const { env, db } = makeEnv();
    // 种子用户（id=1）；general 频道及成员关系由 schema-baseline 种子触发器保证
    await db.run(`INSERT INTO users (username, display_name, password_hash, password_salt, is_admin) VALUES ('admin','管理员','x','y',1)`);

    const room = new ChannelRoom(makeState(), env);
    const request = new Request('https://internal/client-action', {
      method: 'POST',
      headers: verifiedHeaders('1', '1'),
      body: JSON.stringify({
        room: { kind: 'public', id: 1 },
        action: { type: 'send', content: '通过DO提交', clientMessageId: crypto.randomUUID() },
      }),
    });

    const response = await room.fetch(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { created?: boolean; message?: { id: number; content: string; sender?: { username?: string } } };
    expect(body.created).toBe(true);
    expect(body.message?.content).toBe('通过DO提交');
    expect(body.message?.sender?.username).toBe('admin');

    // 落库真值：密文存储 + mention 列默认
    const row = db.first<{ content: string; channel_id: number }>('SELECT content, channel_id FROM messages WHERE id = ?', body.message?.id);
    expect(row!.channel_id).toBe(1);
    expect(row!.content).not.toBe('通过DO提交');
  });

  it('/client-action send：非成员 private 频道 → 403 forbidden', async () => {
    const { env, db } = makeEnv();
    // 先建 private 频道 + owner；然后换非成员用户（id=2）
    await db.run(`INSERT INTO users (username, display_name, password_hash, password_salt, is_admin) VALUES ('owner','所有者','x','y',0)`);
    await db.run(`INSERT INTO channels (name, description, kind, created_by) VALUES ('密谈','','private',1)`);
    const privateChannel = db.first<{ id: number }>("SELECT id FROM channels WHERE name = '密谈'");
    await db.run(`INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, 1, 'owner')`, privateChannel!.id);
    await db.run(`INSERT INTO users (username, display_name, password_hash, password_salt, is_admin) VALUES ('outsider','外人','x','y',0)`);

    const room = new ChannelRoom(makeState(), env);
    const request = new Request('https://internal/client-action', {
      method: 'POST',
      headers: verifiedHeaders('2', '0'),
      body: JSON.stringify({
        room: { kind: 'private', id: privateChannel!.id },
        action: { type: 'send', content: '混进来', clientMessageId: crypto.randomUUID() },
      }),
    });

    const response = await room.fetch(request);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('forbidden');
  });
});
