// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 登录失败限速（#186 S2）服务级行为：真 SQLite（migrations/core/*.sql 真建表）。
 * 断言的是「限速触发/不触发、成功清零、窗口过期」的行为，不是实现细节。
 */
import { describe, expect, it } from 'vitest';

import {
  clearLoginFailures,
  isLoginThrottled,
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_SECONDS,
  recordLoginFailure,
} from '../src/services/rate-limit';
import { createCoreDb, type CoreTestDb } from './test-factory';

const ALICE = 'alice';
const BOB = 'bob';
const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.9';

/** 连续记 N 次失败（走真库计数路径）。 */
async function failTimes(
  db: CoreTestDb,
  username: string,
  ip: string,
  times: number,
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await recordLoginFailure(db.d1, username, ip);
  }
}

describe('登录失败限速（#186 S2）', () => {
  it('阈值内不限速：失败 4 次仍可继续尝试', async () => {
    const db = createCoreDb();
    try {
      await failTimes(db, ALICE, IP, LOGIN_FAILURE_LIMIT - 1);
      expect(await isLoginThrottled(db.d1, ALICE, IP)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('同一用户名连续失败达阈值 → 限速', async () => {
    const db = createCoreDb();
    try {
      await failTimes(db, ALICE, IP, LOGIN_FAILURE_LIMIT);
      expect(await isLoginThrottled(db.d1, ALICE, IP)).toBe(true);
      // 另一 IP 上的同名尝试同样被用户名轴拦（换 IP 不能继续爆破该账号）
      expect(await isLoginThrottled(db.d1, ALICE, OTHER_IP)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('同一 IP 对多个用户名失败达阈值 → 限速（防喷洒，未知用户名也计数）', async () => {
    const db = createCoreDb();
    try {
      for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
        await recordLoginFailure(db.d1, `user-${i}`, IP); // 每个用户名只错 1 次
      }
      expect(await isLoginThrottled(db.d1, BOB, IP)).toBe(true);
      // IP 轴不牵连别的来源
      expect(await isLoginThrottled(db.d1, BOB, OTHER_IP)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('成功登录清零：同一用户名/IP 重新计数（不再被旧失败拦住）', async () => {
    const db = createCoreDb();
    try {
      await failTimes(db, ALICE, IP, LOGIN_FAILURE_LIMIT);
      expect(await isLoginThrottled(db.d1, ALICE, IP)).toBe(true);

      await clearLoginFailures(db.d1, ALICE, IP);
      expect(await isLoginThrottled(db.d1, ALICE, IP)).toBe(false);
      expect(db.query('SELECT key FROM login_attempts')).toEqual([]);

      // 清零后重新失败 4 次仍不到阈值（证明计数真从头开始）
      await failTimes(db, ALICE, IP, LOGIN_FAILURE_LIMIT - 1);
      expect(await isLoginThrottled(db.d1, ALICE, IP)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('窗口过期：历史满额计数不再拦，且下一次失败从新窗口重新起算', async () => {
    const db = createCoreDb();
    try {
      const expired = Math.floor(Date.now() / 1000) - LOGIN_FAILURE_WINDOW_SECONDS - 1;
      db.run(
        'INSERT INTO login_attempts (key, failures, window_start) VALUES (?, ?, ?)',
        `u:${ALICE}`,
        LOGIN_FAILURE_LIMIT,
        expired,
      );
      db.run(
        'INSERT INTO login_attempts (key, failures, window_start) VALUES (?, ?, ?)',
        `ip:${IP}`,
        LOGIN_FAILURE_LIMIT,
        expired,
      );

      expect(await isLoginThrottled(db.d1, ALICE, IP)).toBe(false);

      await recordLoginFailure(db.d1, ALICE, IP);
      expect(
        db.query<{ failures: number }>('SELECT failures FROM login_attempts ORDER BY key'),
      ).toEqual([{ failures: 1 }, { failures: 1 }]);
      expect(await isLoginThrottled(db.d1, ALICE, IP)).toBe(false);
    } finally {
      db.close();
    }
  });
});
