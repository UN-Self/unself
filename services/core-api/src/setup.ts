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

/** 消费一次性 token：单条 UPDATE 原子完成（WHERE used_at IS NULL + meta.changes 判定），
 *  并发双激活只有一次能命中（changes=1），另一次 changes=0 → false。 */
export async function consumeSetupToken(db: D1Database, token: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE setup_tokens SET used_at = datetime('now') WHERE token = ? AND used_at IS NULL")
    .bind(token)
    .run();
  return result.meta.changes > 0;
}

/** 只验不消费：token 存在且未使用（oidc-config 端点门禁；可重复提交改填，不消耗）。 */
export async function isSetupTokenValid(db: D1Database, token: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM setup_tokens WHERE token = ? AND used_at IS NULL')
    .bind(token)
    .first();
  return Boolean(row);
}
