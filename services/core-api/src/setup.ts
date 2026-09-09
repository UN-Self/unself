// SPDX-License-Identifier: AGPL-3.0-only

/**
 * setup token 域（setup_tokens 表）：一次性 token 的生成/入库/消费。
 * setup_done 标记在 services/instance-config.ts；首任管理员在 services/users.ts。
 */

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
    .prepare("UPDATE setup_tokens SET used_at = datetime('now') WHERE token = ? AND used_at IS NULL")
    .bind(token)
    .run();
  return true;
}
