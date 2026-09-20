// SPDX-License-Identifier: AGPL-3.0-only

/**
 * setup token 域（setup_tokens 表）：一次性 token 的消费/校验/归还。
 * 签发不在本服务：#165 删公开签发口后由装配器（packages/installer/src/engine/smoke.ts）本地生成 + d1 直插。
 * setup_done 标记在 services/instance-config.ts；首任管理员在 services/users.ts。
 */

/** 消费一次性 token：单条 UPDATE 原子完成（WHERE used_at IS NULL + meta.changes 判定），
 *  并发双激活只有一次能命中（changes=1），另一次 changes=0 → false。
 *  used_by（#49 验收项 5 / #171）：activate 记 session.uid（被提权的用户），
 *  builtin-admin 记新建 admin 的 uid；与 used_at 同一条 UPDATE 落库，不留半条取证状态。 */
export async function consumeSetupToken(db: D1Database, token: string, usedBy: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE setup_tokens SET used_at = datetime('now'), used_by = ? WHERE token = ? AND used_at IS NULL")
    .bind(usedBy, token)
    .run();
  return result.meta.changes > 0;
}

/** 归还预占的 token（builtin-admin 撞 UNIQUE 硬闸时的补偿动作）：
 *  仅当 used_by 等于本请求预写的 uid 才复位（不误放他人已消费的 token），
 *  used_at/used_by 双清 → token 回到「未消费」，换名重试仍可用。 */
export async function releaseSetupToken(db: D1Database, token: string, usedBy: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE setup_tokens SET used_at = NULL, used_by = NULL WHERE token = ? AND used_by = ? AND used_at IS NOT NULL')
    .bind(token, usedBy)
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
