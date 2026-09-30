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

/**
 * 原子消费（一次性）：命中回 `{ email, used_at }`（used_at = 本次写入值，供失败回滚精确守卫），
 * 已用/过期/不存在回 null。
 */
export async function consumeInviteActivation(
  db: D1Database,
  tokenHash: string,
): Promise<{ email: string; used_at: string } | null> {
  return db
    .prepare(
      "UPDATE invite_activations SET used_at = datetime('now') WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now') RETURNING email, used_at",
    )
    .bind(tokenHash)
    .first<{ email: string; used_at: string }>();
}

/**
 * 消费回滚（#151）：后续动作失败时把令牌还给用户——
 * 仅当 used_at 仍是「我们本次写入的那个值」才清（精确守卫）：期间被 claim 重签作废
 * （used_at 被改成别的值）或已被再次消费时不动，避免误放行。回滚命中返回 true。
 */
export async function releaseInviteActivation(
  db: D1Database,
  tokenHash: string,
  consumedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE invite_activations SET used_at = NULL WHERE token_hash = ? AND used_at = ?')
    .bind(tokenHash, consumedAt)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export interface InviteActivationRecord {
  token_hash: string;
  invite_token_hash: string;
  email: string;
  expires_at: string;
  used_at: string | null;
}

/**
 * 读某邀请当前的激活令牌行（重发/claim/状态查询入口用）。
 * 选「最新一行」但**跳过作废占位**（used_at 形如 `invalidated@...`）：作废占位只表示
 * 某次刷新/失败尝试被撤销，不代表有效链接身份；一次失败重发写入的作废占位行不得
 * 遮住它下面仍未用的旧链接（#152 验收实锤：旧模型直接选最新行 → 失败后重试误判 409）。
 * 返回行可能是：未用（used_at NULL）或已真实消费（used_at 时间戳）——两者由调用方
 * 按各自语义判（消费行仍视为不可重发，不得因回退搜索旧行而重新放行）。
 */
export async function findInviteActivationForInvite(
  db: D1Database,
  inviteTokenHash: string,
): Promise<InviteActivationRecord | null> {
  return db
    .prepare(
      "SELECT token_hash, invite_token_hash, email, expires_at, used_at FROM invite_activations WHERE invite_token_hash = ? AND (used_at IS NULL OR used_at NOT LIKE 'invalidated@%') ORDER BY rowid DESC LIMIT 1",
    )
    .bind(inviteTokenHash)
    .first<InviteActivationRecord>();
}

/**
 * 新令牌投递成功后取代更早的未用令牌（#152）：作废同一邀请中 rowid 更小、仍未用的行。
 * 按 **rowid（签发顺序）** 而非完成顺序定序：并发双重重发都成功时，较新签发者最终获胜、
 * 不会被较晚完成的较旧请求反向清掉；较新签发者失败时作废自己，较早的成功者仍然有效。
 * 只动 rowid 更小的行，不碰更新的并发行（由对方的成功/失败分支各自收敛）。
 */
export async function supersedeOlderInviteActivations(
  db: D1Database,
  inviteTokenHash: string,
  keepTokenHash: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE invite_activations SET used_at = 'invalidated@' || datetime('now') WHERE invite_token_hash = ? AND used_at IS NULL AND rowid < (SELECT rowid FROM invite_activations WHERE token_hash = ?)",
    )
    .bind(inviteTokenHash, keepTokenHash)
    .run();
}

/**
 * 作废激活令牌（置 used_at）：只命中未用行，回是否作废成功。
 * used_at IS NULL 守卫让并发双 claim/双重发只有一方成功（#81 原子模式），
 * 败者拿 false —— 「同一时刻至多一个有效明文链接」由这条守卫兜住（#134）。
 *
 * 记号带 `invalidated@` 前缀（#170）：消费写的是裸 datetime('now')，秒粒度下
 * 同秒的作废值会与之相等，失败回滚的精确守卫（releaseInviteActivation）就无法
 * 区分「本次消费」与「他人作废」→ 会复活已作废令牌。前缀让两者恒不相等；
 * 该列全仓读取点只判 null/非 null，不解析时间，故语义不变。
 */
export async function invalidateInviteActivation(db: D1Database, tokenHash: string): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE invite_activations SET used_at = 'invalidated@' || datetime('now') WHERE token_hash = ? AND used_at IS NULL",
    )
    .bind(tokenHash)
    .run();
  return result.meta.changes > 0;
}
