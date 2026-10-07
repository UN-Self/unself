// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
 * Core 是资料唯一写入点：Chat 旧资料写接口拒绝修改，也不存储模块 JWT。
 */

let db: ChatTestDb;
let env: ChatTestEnv;
let sessions: MemoryKv;

beforeEach(() => {
  db = createChatDb();
  sessions = new MemoryKv();
  env = { DB: db.d1, SESSIONS: sessions, ...TEST_VARS };
  installRoomDo(env as unknown as Record<string, unknown>);
  setEnv(env);
});

/** core 签发形状的模块 JWT（ES256 + RFC7638 kid），JWKS 注入 env 本地验签。 */
async function mintToken(sub: string): Promise<string> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  env.CORE_JWKS_JSON = JSON.stringify({ keys: [{ ...publicJwk, kid, use: 'sig', alg: 'ES256' }] });
  return new SignJWT({ iss: 'unself-core', sub, aud: 'chat' })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(pair.privateKey);
}

function patchProfile(token: string, body: Record<string, unknown>): Promise<Response> {
  return app.request('https://chat.example/api/me/profile', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Chat 不再独立修改个人资料', () => {
  it('PATCH 拒绝修改昵称和简介；D1 与 SESSIONS KV 均不写入', async () => {
    const put = vi.spyOn(sessions, 'put');
    const token = await mintToken('u_231');

    const res = await patchProfile(token, { displayName: '新展示名', bio: '新简介' });
    expect(res.status).toBe(403);

    const row = db.first<{ display_name: string; bio: string }>(
      'SELECT display_name, bio FROM users WHERE username = ?',
      'core:u_231',
    );
    expect(row?.display_name).not.toBe('新展示名');
    expect(row?.bio).not.toBe('新简介');

    // 关键断言：KV 无任何写入，token 也不在 KV 中
    expect(put).not.toHaveBeenCalled();
    expect(await sessions.get(token)).toBeNull();
  });
});
