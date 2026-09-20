// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { runScheduledGc } from '../worker/src/gc.js';
import { createChatDb, MemoryKv, TEST_VARS, type ChatTestEnv } from './chat-test-factory';

/**
 * GC 空库冒烟：空库（零用户/零消息）+ 无 R2 绑定（env.FILES 缺省）下
 * runScheduledGc 跑通不炸——无 R2 走降级路径、GC 预算参数从 env 读取走通。
 */
describe('runScheduledGc 空库冒烟（FILES 缺省降级）', () => {
  it('空库跑通不炸且返回结果对象（DB 真 SQLite、无 R2 绑定）', async () => {
    const db = createChatDb();
    const env = {
      DB: db.d1,
      SESSIONS: new MemoryKv(),
      ...TEST_VARS,
    } satisfies ChatTestEnv;

    const result = await runScheduledGc(env as unknown as Parameters<typeof runScheduledGc>[0]);
    expect(result).toBeDefined();
    db.close();
  });
});
