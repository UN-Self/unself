// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 内置登录失败限速（#186 S2）：D1 小表固定窗口计数。
 * 不引外部限流服务、不做可配置项（用户拍板「最薄方案」）——阈值/窗口只住在这里。
 *
 * 表住 migrations/core/0006_login_attempts.sql。两轴独立计数（同一 key 空间，前缀区分）：
 * - `u:<username>`：护账号，防定向爆破；
 * - `ip:<addr>`：护喷洒，防换用户名广撒。
 * 失败时两轴各 +1；成功登录把两行都删（清零）。未知用户名同样计数——
 * 429 因此不构成「账号存在性」探针。
 *
 * 固定窗口语义：窗口自首次失败起算，窗口内累加，窗口过期后下一次失败开新窗口。
 * 计数清零以成功登录为准（连续失败的定义），不做滑动平均/指数退避。
 */

/** 触发限速的连续失败次数。 */
export const LOGIN_FAILURE_LIMIT = 5;
/** 窗口长度（秒）：15 分钟。窗口过期即计数失效、可重新尝试。 */
export const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;

interface AttemptRow {
  failures: number;
  window_start: number;
}

/** 两轴计数键（IP 未知时统一记 'unknown'，仍是一条可计数、可清零的桶）。 */
export function loginThrottleKeys(username: string, ip: string): string[] {
  return [`u:${username}`, `ip:${ip}`];
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 是否处于限速中：任一轴在窗口内达到阈值即拒（窗口过期的历史计数不再拦）。 */
export async function isLoginThrottled(
  db: D1Database,
  username: string,
  ip: string,
): Promise<boolean> {
  const now = nowSeconds();
  for (const key of loginThrottleKeys(username, ip)) {
    const row = await db
      .prepare('SELECT failures, window_start FROM login_attempts WHERE key = ?')
      .bind(key)
      .first<AttemptRow>();
    if (
      row &&
      row.failures >= LOGIN_FAILURE_LIMIT &&
      now - row.window_start < LOGIN_FAILURE_WINDOW_SECONDS
    ) {
      return true;
    }
  }
  return false;
}

/** 记一次登录失败：窗口内累加；窗口过期（或首次）则开新窗口，从 1 起算。 */
export async function recordLoginFailure(
  db: D1Database,
  username: string,
  ip: string,
): Promise<void> {
  const now = nowSeconds();
  for (const key of loginThrottleKeys(username, ip)) {
    const row = await db
      .prepare('SELECT failures, window_start FROM login_attempts WHERE key = ?')
      .bind(key)
      .first<AttemptRow>();
    if (!row || now - row.window_start >= LOGIN_FAILURE_WINDOW_SECONDS) {
      await db
        .prepare(
          `INSERT INTO login_attempts (key, failures, window_start) VALUES (?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start`,
        )
        .bind(key, now)
        .run();
    } else {
      await db
        .prepare('UPDATE login_attempts SET failures = failures + 1 WHERE key = ?')
        .bind(key)
        .run();
    }
  }
}

/** 成功登录：两轴计数清零（删行，不留历史；「连续失败」被成功打断）。 */
export async function clearLoginFailures(
  db: D1Database,
  username: string,
  ip: string,
): Promise<void> {
  for (const key of loginThrottleKeys(username, ip)) {
    await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
  }
}
