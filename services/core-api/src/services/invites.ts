// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 邀请域（invites 表）：链接生成 / 列表 / 惰性过期 / 状态迁移 / 填表更新，
 * 以及首登建档时按个人邮箱消费已批准邀请（#49，SPEC §5.7 弱化实例）。
 *
 * 口径：
 * - 令牌明文只在生成响应里出现一次，库里只存 SHA-256 哈希（token_hash 主键）；
 * - 状态迁移一律走 assertInviteTransition（#47 契约）+ 单条 UPDATE 状态守卫，
 *   并发双写只有一次 changes=1（#81 原子模式）；
 * - 过期不做定时任务，读取路径惰性判定（2026-09-10 拍板：一次性 + 限期足够）；
 * - 内置注册凭证（issue-A）住 invite_credentials 表（与 invites 主键同形 token_hash），
 *   提交时落 username+password_hash，批准时据此开户（决策 28/30）。
 */
import { assertInviteTransition, type InviteStatus } from '@unself/contracts';
import { hashPassword } from './passwords';

/** 消费结果三分支：命中消费 / 无匹配（无邀请）/ 已消费。 */
export type ConsumeInviteOutcome = 'consumed' | 'none' | 'already_consumed';

/** 邀请默认有效期（天）：申请链接限期（SPEC 链路 1「一次性/限期」）。 */
export const DEFAULT_INVITE_EXPIRES_DAYS = 7;

/** 匹配到的邀请行（只取判定所需列）。 */
interface InviteRow {
  token_hash: string;
  status: InviteStatus;
  personal_email: string;
}

/** 邀约行（管理端列表 / 公开页读取形状）；due=1 表示已到期待惰性过期。 */
export interface Invite extends InviteRow {
  email_prefix: string;
  display_name: string;
  created_at: string;
  expires_at: string;
  due: number;
}

/** 列表/单条共用的取列口径（due 由 SQLite 直接判定，避免 JS 时区口径漂移）。 */
const INVITE_COLUMNS =
  "token_hash, status, personal_email, email_prefix, display_name, created_at, expires_at, (expires_at <= datetime('now')) AS due";

/** 申请表单提交的字段（#18 公开填表页；issue-A 增加内置注册用户名/密码，两者必须同时有）。 */
export interface InviteApplication {
  displayName: string;
  emailPrefix: string;
  personalEmail: string;
  username?: string;
  password?: string;
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

/** 生成邀请行（pending，未填表；带哈希的 token 由调用方生成/返回明文）。 */
export async function createInvite(
  db: D1Database,
  tokenHash: string,
  expiresInDays: number = DEFAULT_INVITE_EXPIRES_DAYS,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO invites (token_hash, status, personal_email, email_prefix, display_name, expires_at) VALUES (?, 'pending', '', '', '', datetime('now', ?))",
    )
    .bind(tokenHash, `+${expiresInDays} days`)
    .run();
}

/** 管理端全量列表（倒序；先批量惰性判定过期）。 */
export async function listInvites(db: D1Database): Promise<Invite[]> {
  await expireDueInvites(db);
  const result = await db
    .prepare(`SELECT ${INVITE_COLUMNS} FROM invites ORDER BY created_at DESC, rowid DESC`)
    .all<Invite>();
  return result.results;
}

/** 单条读取；pending 且已到期 → 当场置 expired 并按过期返回（惰性判定）。 */
export async function findInvite(db: D1Database, tokenHash: string): Promise<Invite | null> {
  const invite = await db
    .prepare(`SELECT ${INVITE_COLUMNS} FROM invites WHERE token_hash = ?`)
    .bind(tokenHash)
    .first<Invite>();
  if (!invite) {
    return null;
  }
  if (invite.status === 'pending' && invite.due === 1) {
    // 契约状态机校验（#47）：pending → expired 合法；并发重复置位无害
    await setInviteStatus(db, tokenHash, 'pending', 'expired');
    return { ...invite, status: 'expired' };
  }
  return invite;
}

/** 批量惰性过期（列表路径一次 UPDATE 扫掉全部到期 pending）。 */
export async function expireDueInvites(db: D1Database): Promise<number> {
  // 契约状态机校验（#47）：pending → expired 是合法迁移（与单行口径同源）
  assertInviteTransition('pending', 'expired');
  const result = await db
    .prepare("UPDATE invites SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')")
    .run();
  return result.meta.changes;
}

/**
 * 原子状态迁移：状态守卫 + meta.changes 判定。
 * 非法迁移（如 approved → approved）由契约提前抛错，路由层负责先给 409 人话。
 */
export async function setInviteStatus(
  db: D1Database,
  tokenHash: string,
  from: InviteStatus,
  to: InviteStatus,
): Promise<boolean> {
  assertInviteTransition(from, to);
  const result = await db
    .prepare('UPDATE invites SET status = ? WHERE token_hash = ? AND status = ?')
    .bind(to, tokenHash, from)
    .run();
  return result.meta.changes > 0;
}

/** 写入申请表单（只允许 pending 行；过期/已审批后提交一律 false → 410）。 */
export async function updateInviteApplication(
  db: D1Database,
  tokenHash: string,
  application: InviteApplication,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE invites SET display_name = ?, email_prefix = ?, personal_email = ? WHERE token_hash = ? AND status = 'pending'",
    )
    .bind(application.displayName, application.emailPrefix, application.personalEmail, tokenHash)
    .run();
  if (result.meta.changes === 0) {
    return false;
  }
  // 内置注册凭证（issue-A）：独立表 INSERT，一链接至多一行；未填用户名则不落行
  if (application.username !== undefined && application.password !== undefined) {
    await saveInviteCredentials(db, tokenHash, application.username, await hashPassword(application.password));
  }
  return true;
}

/** 落内置注册凭证（UPDATE 换 INSERT：SQLite 无 UPSERT-keep-existing；重填覆盖走 REPLACE）。 */
async function saveInviteCredentials(
  db: D1Database,
  tokenHash: string,
  username: string,
  passwordHash: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO invite_credentials (token_hash, username, password_hash) VALUES (?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash',
    )
    .bind(tokenHash, username, passwordHash)
    .run();
}

/** 读取邀请的内置注册凭证（批准时硬闸开户用）；无内置注册 → null。 */
export async function getInviteCredentials(
  db: D1Database,
  tokenHash: string,
): Promise<{ username: string; password_hash: string } | null> {
  return db
    .prepare('SELECT username, password_hash FROM invite_credentials WHERE token_hash = ?')
    .bind(tokenHash)
    .first<{ username: string; password_hash: string }>();
}
