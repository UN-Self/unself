// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 邀请域（invites 表）：首登建档时按个人邮箱消费已批准邀请（#49，SPEC §5.7 弱化实例）。
 * 消费沿用 #81 setup token 的原子模式：单条 UPDATE + status 守卫 + meta.changes 判定。
 */
import { assertInviteTransition, type InviteStatus } from '@unself/contracts';

/** 消费结果三分支：命中消费 / 无匹配（无邀请）/ 已消费。 */
export type ConsumeInviteOutcome = 'consumed' | 'none' | 'already_consumed';

/** 匹配到的邀请行（只取判定所需列）。 */
interface InviteRow {
  token_hash: string;
  status: InviteStatus;
  personal_email: string;
}

/**
 * 首登建档时消费该邮箱最新的已批准邀请：
 * - 命中 status='approved' → 置 consumed（并发双登录只有一次 changes=1）并回填 users.personal_email；
 * - 无该邮箱邀请 → none（正常建档）；
 * - 已消费 / 并发败者 → already_consumed（不重复消费、不覆盖档案）。
 * 邮箱匹配大小写不敏感（SQL lower 两侧）。
 */
export async function consumeApprovedInviteByEmail(
  db: D1Database,
  userId: string,
  email: string,
): Promise<ConsumeInviteOutcome> {
  const invite = await db
    .prepare(
      "SELECT token_hash, status, personal_email FROM invites WHERE lower(personal_email) = lower(?) AND status = 'approved' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(email)
    .first<InviteRow>();
  if (!invite) {
    const consumed = await db
      .prepare(
        "SELECT 1 FROM invites WHERE lower(personal_email) = lower(?) AND status = 'consumed' LIMIT 1",
      )
      .bind(email)
      .first();
    return consumed ? 'already_consumed' : 'none';
  }
  // 契约状态机校验（#47）：approved → consumed 为合法迁移
  assertInviteTransition(invite.status, 'consumed');
  const result = await db
    .prepare("UPDATE invites SET status = 'consumed' WHERE token_hash = ? AND status = 'approved'")
    .bind(invite.token_hash)
    .run();
  if (result.meta.changes === 0) {
    // TOCTOU：另一登录在 SELECT 与 UPDATE 之间消费了同一条邀请
    return 'already_consumed';
  }
  await db
    .prepare('UPDATE users SET personal_email = ? WHERE id = ?')
    .bind(invite.personal_email, userId)
    .run();
  return 'consumed';
}
