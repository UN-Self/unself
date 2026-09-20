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
 * #231 SESSIONS KV 明文 JWT 残件（行为面）：本地会话读取面已被 core 模块 JWT + JIT 取代
 * （#217），但 PATCH /api/me/profile 仍把模块 JWT 明文 putSession 进 SESSIONS KV
 * （TTL 7 天 > token 自身 10 分钟）。本套件盯「PATCH 后 KV 零写入」这一可观测外部效果，
 * 同时正向确认资料真落 D1（不是靠短路成功骗绿）。
 *
 * 红灯：恢复 user-profile.ts 的 putSession 回写 → KV put 断言即红。
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

describe('#231 PATCH /api/me/profile 不再回写 SESSIONS KV', () => {
  it('PATCH 200 且资料真落 D1；SESSIONS KV 零写入（模块 JWT 不落 KV）', async () => {
    const put = vi.spyOn(sessions, 'put');
    const token = await mintToken('u_231');

    const res = await patchProfile(token, { displayName: '新展示名', bio: '新简介' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { username: string; displayName: string; bio: string };
    };
    expect(body.session.username).toBe('core:u_231');
    expect(body.session.displayName).toBe('新展示名');
    expect(body.session.bio).toBe('新简介');

    // 正向控制：资料真落 D1（避免「请求其实没生效」被误读成「没写 KV」）
    const row = db.first<{ display_name: string; bio: string }>(
      'SELECT display_name, bio FROM users WHERE username = ?',
      'core:u_231',
    );
    expect(row?.display_name).toBe('新展示名');
    expect(row?.bio).toBe('新简介');

    // 关键断言：KV 无任何写入，token 也不在 KV 中
    expect(put).not.toHaveBeenCalled();
    expect(await sessions.get(token)).toBeNull();
  });
});
