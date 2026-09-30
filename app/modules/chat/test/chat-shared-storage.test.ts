// SPDX-License-Identifier: AGPL-3.0-only
/**
 * shared 落点读写行为（#310）：真 SQLite 加载 `chat_` 前缀基线，env 走 wrapEnv 注入
 * `DB_TABLE_PREFIX=chat_`，跑路由级 app.request（bootstrap）与直写，断言读写都落在前缀表上。
 *
 * 这是「shared 与 dedicated 可独立验证」的行为证据：同一套 worker 代码，仅靠前缀映射跑通。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';

import { app, setEnv } from './worker-app';
import { installRoomDo } from './do-stub';
import {
  createChatDb,
  MemoryKv,
  SHARED_SCHEMA_BASELINE_PATH,
  TEST_VARS,
  type ChatTestDb,
  type ChatTestEnv,
} from './chat-test-factory';
import { wrapEnv } from '../worker/src/unself-env.js';

let db: ChatTestDb;
let env: ChatTestEnv;

beforeEach(() => {
  db = createChatDb({ schemaPath: SHARED_SCHEMA_BASELINE_PATH });
  const base: ChatTestEnv = {
    DB: db.d1,
    SESSIONS: new MemoryKv(),
    ...TEST_VARS,
    DB_TABLE_PREFIX: 'chat_',
  };
  // 与 worker 入口一致：env 经 wrapEnv 收口（DB 前缀 + FILES 来源）
  env = wrapEnv(base) as ChatTestEnv;
  installRoomDo(env as unknown as Record<string, unknown>);
  setEnv(env);
});

async function mintToken(): Promise<string> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  env.CORE_JWKS_JSON = JSON.stringify({ keys: [{ ...publicJwk, kid, use: 'sig', alg: 'ES256' }] });
  return new SignJWT({ iss: 'unself-core', sub: 'u_shared', aud: 'chat', name: '共享用户' })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(pair.privateKey);
}

describe('shared 落点（chat_ 前缀）读写行为（issue 310）', () => {
  it('bootstrap 经前缀表完成 JIT 建档 + general 入席，行落 chat_* 表', async () => {
    const token = await mintToken();
    const res = await app.request('https://chat.example/api/bootstrap', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: Array<{ name: string }> };
    expect(body.channels.some((c) => c.name === 'general')).toBe(true);

    // 直查真库：用户与成员资格都写进了带前缀的物理表
    expect(db.query('SELECT username FROM chat_users WHERE username = ?', 'core:u_shared')).toHaveLength(1);
    expect(
      db.query(
        'SELECT 1 FROM chat_channel_members m JOIN chat_users u ON u.id = m.user_id WHERE u.username = ?',
        'core:u_shared',
      ),
    ).toHaveLength(1);
    // 未加前缀的旧表名在 shared 库里不存在（证明没有静默回退到 dedicated 表名）
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'"),
    ).toHaveLength(0);
  });

  it('缺 DB_TABLE_PREFIX（dedicated 形态）时读不到 shared 前缀表——证明前缀是唯一开关', async () => {
    // 反向对照：同一 shared 库，前缀关掉 → 裸表名查询必然失败（不静默回退）
    const bare = wrapEnv({
      DB: db.d1,
      SESSIONS: new MemoryKv(),
      ...TEST_VARS,
    } as ChatTestEnv);
    await expect(
      (bare.DB as ChatTestDb['d1']).prepare('SELECT * FROM users LIMIT 1').all(),
    ).rejects.toThrow();
  });
});
