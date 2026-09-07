// SPDX-License-Identifier: AGPL-3.0-only
import type { Bindings } from './index';

/** setup 已完成标记（instance_config 键）。 */
export const SETUP_DONE_KEY = 'setup_done';

/** setup token 随机长度（字节）。 */
const SETUP_TOKEN_BYTES = 24;

/** 一次性 setup token 形状。 */
export interface SetupToken {
  /** 随机 token（URL-safe）。 */
  token: string;
  /** 生成时间（UNIX 秒）。 */
  createdAt: number;
}

/** 生成一次性 setup token（部署脚本/自检端点用，打印进部署输出）。 */
export function generateSetupToken(): SetupToken {
  const buf = new Uint8Array(SETUP_TOKEN_BYTES);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  const token = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { token, createdAt: Math.floor(Date.now() / 1000) };
}

/** 把 token 写入 core 库（一次性，未使用）。 */
export async function storeSetupToken(db: D1Database, token: string): Promise<void> {
  await db
    .prepare('INSERT INTO setup_tokens (token) VALUES (?)')
    .bind(token)
    .run();
}

/** setup 是否已完成（已完成后整条 setup 链路永久封死，§5.2）。 */
export async function isSetupDone(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare('SELECT value FROM instance_config WHERE key = ?')
    .bind(SETUP_DONE_KEY)
    .first<{ value: string }>();
  return row?.value === '1';
}

/** 标记 setup 完成（幂等：只在未完成时写）。 */
export async function markSetupDone(db: D1Database): Promise<void> {
  await db
    .prepare('INSERT INTO instance_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime(\'now\')')
    .bind(SETUP_DONE_KEY, '1')
    .run();
}

/** 消费一次性 token：命中未使用则标记已用并返回 true；否则 false（用后即封死）。 */
export async function consumeSetupToken(db: D1Database, token: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT used_at FROM setup_tokens WHERE token = ?')
    .bind(token)
    .first<{ used_at: string | null }>();
  if (!row || row.used_at) {
    return false; // 不存在或已使用 → 拒绝
  }
  await db
    .prepare('UPDATE setup_tokens SET used_at = datetime(\'now\') WHERE token = ? AND used_at IS NULL')
    .bind(token)
    .run();
  return true;
}

/** 把用户提升为管理员（首个管理员诞生，§5.2）。 */
export async function promoteToAdmin(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare('UPDATE users SET role = ? WHERE id = ?')
    .bind('admin', userId)
    .run();
}

/** 记审计（部署/管理员动作留痕，§6.5 异常排查）。 */
export async function audit(db: D1Database, actor: string, action: string, target?: string): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (actor, action, target) VALUES (?, ?, ?)')
    .bind(actor, action, target ?? null)
    .run();
}

/** Bindings 类型引用（保持与路由同源）。 */
export type { Bindings };
