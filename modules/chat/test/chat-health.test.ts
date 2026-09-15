// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';

import { app, setEnv } from './worker-app';
import { createChatDb, MemoryKv, TEST_VARS } from './chat-test-factory';

/**
 * chat 健康检查（不依赖 DB/KV 的最小可用面）：
 * GET /api/health → 200 {ok:true}（/api/* 中间件要求 env 已注入，用最小 env）。
 */
describe('chat /api/health', () => {
  beforeEach(() => {
    setEnv({ DB: createChatDb().d1, SESSIONS: new MemoryKv(), ...TEST_VARS });
  });

  it('健康检查回 200 {ok:true}', async () => {
    const res = await app.request('https://chat.example/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
