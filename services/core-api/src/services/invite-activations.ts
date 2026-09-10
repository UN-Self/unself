// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 激活令牌域（invite_activations 表，#18 完整实例）：
 * 批准开号后随 account_ready 邮件发到受邀人个人邮箱的一次性链接，48h 限期。
 *
 * 口径（2026-09-10 拍板）：「自设密码」= 调 MailProvisioner.resetPassword 设**邮箱密码**，
 * 与登录用 IdP 账户无关（SPEC §5.7 表）；Unself 不做密码同步。
 * 消费沿用 #81 原子模式：单条 UPDATE + used_at/expires_at 守卫 + RETURNING，
 * 并发双激活只有一次命中（changes=1），另一次拿不到行。
 * 库中只留令牌 SHA-256 哈希（入参即哈希，公开路由负责把 URL 明文哈希化）。
 */
import { hashOneTimeToken, generateOneTimeToken } from '../one-time-token';

/** 激活令牌有效期（小时）：拍板 48h。 */
export const ACTIVATION_TTL_HOURS = 48;

/** 签发激活令牌：返回明文（只此一次，拼进邮件链接），库里只存哈希。 */
export async function issueInviteActivation(
  db: D1Database,
  inviteTokenHash: string,
  email: string,
): Promise<string> {
  const token = generateOneTimeToken();
  await db
    .prepare(
      "INSERT INTO invite_activations (token_hash, invite_token_hash, email, expires_at) VALUES (?, ?, ?, datetime('now', ?))",
    )
    .bind(await hashOneTimeToken(token), inviteTokenHash, email, `+${ACTIVATION_TTL_HOURS} hours`)
    .run();
  return token;
}

/** 只验不消费：未用且未过期才回工作邮箱（GET 激活页展示用）。 */
export async function findInviteActivation(
  db: D1Database,
  tokenHash: string,
): Promise<{ email: string } | null> {
  return db
    .prepare(
      "SELECT email FROM invite_activations WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')",
    )
    .bind(tokenHash)
    .first<{ email: string }>();
}

/** 原子消费（一次性）：命中回工作邮箱，已用/过期/不存在回 null。 */
export async function consumeInviteActivation(
  db: D1Database,
  tokenHash: string,
): Promise<{ email: string } | null> {
  return db
    .prepare(
      "UPDATE invite_activations SET used_at = datetime('now') WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now') RETURNING email",
    )
    .bind(tokenHash)
    .first<{ email: string }>();
}
