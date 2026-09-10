// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 通知域（#19）：投递口径与读侧查询。
 *
 * 决策出处：
 * - 通知类型表（type/template/in_app/email）承载行为，类型是数据不是代码（SPEC §6.6）：
 *   查不到类型的 type 一律不投递（deliverNotification 返回 null），未来类型只需种一行。
 * - 触发即发、失败落审计、不重试不排队（2026-09-10 拍板）：先写站内再发信，
 *   单封发信失败只落 audit_log，站内通知不受影响，也不补偿重投。
 * - 邮件渠道查 mail 段装配状态，段缺失/不完整即静默降级（与 routes/settings.ts 同口径）。
 * - 弱化实例（无邮件）邀请审批闭环可用：invite_result 对尚未建档的受邀人先按
 *   invited_email 悬挂站内通知，首登建档后由 bindPendingNotifications 归属（#47/#49）。
 */
import {
  createMailSenderFromConfig,
  renderAccountReady,
  renderInviteResult,
  renderModuleToggled,
  type MailSender,
} from '@unself/mail-smtp';

import { audit } from './audit';

/** 站内/邮件收件人口径：已建档用户 / 待建档受邀邮箱 / 全员广播。 */
export type NotificationRecipient =
  | { userId: string; email?: string }
  | { invitedEmail: string }
  | { broadcast: true };

/** 邮件渠道结果：未装配或渠道关闭 → skipped；全部成功 → sent；任一失败 → failed。 */
export type MailOutcome = 'sent' | 'skipped' | 'failed';

/** 一次投递的结果：站内写入行数 + 邮件渠道结果。 */
export interface DeliveryResult {
  inApp: number;
  email: MailOutcome;
}

/** 解析后的单个收件人：站内归属（user_id）与邮件地址解耦。 */
interface ResolvedRecipient {
  userId: string | null;
  invitedEmail: string | null;
  email: string | null;
}

/** 通知类型行（渠道位来自数据表）。 */
interface NotificationTypeRow {
  template: string;
  in_app: number;
  email: number;
}

/** 普通文本字段：缺失/非字符串 → 空串（模板渲染层统一字符串）。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 可选文本：非空字符串才返回，供「A 优先、B 兜底」取值。 */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 失败原因转人话：Error 取 message，其余 String。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 解析收件人：broadcast 查全体 active（含操作者本人）；invitedEmail 悬挂；userId 取传入或库中邮箱。 */
async function resolveRecipients(
  db: D1Database,
  recipient: NotificationRecipient,
): Promise<ResolvedRecipient[]> {
  if ('broadcast' in recipient) {
    const rows = await db
      .prepare("SELECT id, email FROM users WHERE status = 'active'")
      .all<{ id: string; email: string | null }>();
    return rows.results.map((row) => ({
      userId: row.id,
      invitedEmail: null,
      email: row.email,
    }));
  }
  if ('invitedEmail' in recipient) {
    return [{ userId: null, invitedEmail: recipient.invitedEmail, email: recipient.invitedEmail }];
  }
  const stored =
    recipient.email !== undefined
      ? recipient.email
      : (
          await db
            .prepare('SELECT email FROM users WHERE id = ?')
            .bind(recipient.userId)
            .first<{ email: string | null }>()
        )?.email;
  return [{ userId: recipient.userId, invitedEmail: null, email: stored ?? null }];
}

/** 按类型渲染邮件：已知类型走 mail-smtp 模板，未来类型用类型表 template 作主题、正文留空。 */
function renderNotification(
  type: string,
  template: string,
  payload: Record<string, unknown>,
): { subject: string; text: string } {
  switch (type) {
    case 'invite_result':
      return renderInviteResult(payload.approved === true, {
        name: text(payload.name),
        approver: text(payload.approver),
      });
    case 'account_ready':
      return renderAccountReady(text(payload.email), text(payload.activateUrl));
    case 'module_toggled':
      return renderModuleToggled(
        optionalText(payload.moduleName) ?? optionalText(payload.moduleId) ?? '',
        payload.enabled === true,
      );
    default:
      return { subject: template, text: '' };
  }
}

/**
 * 触发一次通知投递（内部口径，不暴露 HTTP）：
 * 1. 按 type 查渠道位；无该类型 → null（不投递）；
 * 2. in_app=1 → 逐收件人写站内行（payload 原样 JSON 存储）；
 * 3. email=1 且有 sender → 逐收件人发信，单封失败各自落审计，不影响站内与其他收件人。
 */
export async function deliverNotification(
  db: D1Database,
  mailSender: MailSender | null,
  type: string,
  payload: Record<string, unknown>,
  recipient: NotificationRecipient,
): Promise<DeliveryResult | null> {
  const config = await db
    .prepare('SELECT template, in_app, email FROM notification_types WHERE type = ?')
    .bind(type)
    .first<NotificationTypeRow>();
  if (!config) {
    return null;
  }

  const recipients = await resolveRecipients(db, recipient);

  let inApp = 0;
  if (config.in_app === 1) {
    for (const target of recipients) {
      await db
        .prepare(
          'INSERT INTO notifications (id, user_id, invited_email, type, payload) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(crypto.randomUUID(), target.userId, target.invitedEmail, type, JSON.stringify(payload))
        .run();
      inApp += 1;
    }
  }

  if (config.email !== 1 || !mailSender) {
    return { inApp, email: 'skipped' };
  }

  const rendered = renderNotification(type, config.template, payload);
  let failed = false;
  for (const target of recipients) {
    if (!target.email) {
      continue;
    }
    try {
      await mailSender.send({ to: target.email, subject: rendered.subject, text: rendered.text });
    } catch (error) {
      failed = true;
      await audit(
        db,
        'system',
        'notification_email_failed',
        `${target.email}（${type}）：${describeError(error)}`,
      );
    }
  }
  return { inApp, email: failed ? 'failed' : 'sent' };
}

/**
 * 从 instance_config 的 mail 段装配发信口：无段/JSON 非法 → null（弱化实例静默降级）。
 * 字段不完整由 createMailSenderFromConfig 判定，同样回 null。
 */
export async function configuredMailSender(db: D1Database): Promise<MailSender | null> {
  const row = await db
    .prepare("SELECT value FROM instance_config WHERE key = 'mail'")
    .bind()
    .first<{ value: string }>();
  if (!row) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return createMailSenderFromConfig(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * 首登建档后把按 invited_email 悬挂的站内通知归属到该用户（#47/#49 补投）。
 * 邮箱大小写不敏感（SQL lower 两侧，与 services/invites.ts 同口径）；返回绑定行数。
 */
export async function bindPendingNotifications(
  db: D1Database,
  userId: string,
  email: string,
): Promise<number> {
  const result = await db
    .prepare(
      'UPDATE notifications SET user_id = ? WHERE user_id IS NULL AND lower(invited_email) = lower(?)',
    )
    .bind(userId, email)
    .run();
  return result.meta.changes;
}

/** 通知中心列表项（payload 已解析，isRead 已布尔化）。 */
export interface NotificationListItem {
  id: string;
  type: string;
  typeLabel: string;
  payload: unknown;
  isRead: boolean;
  createdAt: string;
}

/** 通知行（列表查询形状）。 */
interface NotificationListRow {
  id: string;
  type: string;
  type_label: string | null;
  payload: string;
  is_read: number;
  created_at: string;
}

/**
 * 当前用户最近 100 条站内通知（新→旧，同秒按 rowid 兜底）。
 * typeLabel 取类型表 template（中文别名）；类型表无行时退回 type 原文。
 */
export async function listNotifications(
  db: D1Database,
  userId: string,
): Promise<NotificationListItem[]> {
  const rows = await db
    .prepare(
      'SELECT n.id, n.type, t.template AS type_label, n.payload, n.is_read, n.created_at FROM notifications n LEFT JOIN notification_types t ON t.type = n.type WHERE n.user_id = ? ORDER BY n.created_at DESC, n.rowid DESC LIMIT 100',
    )
    .bind(userId)
    .all<NotificationListRow>();
  return rows.results.map((row) => ({
    id: row.id,
    type: row.type,
    typeLabel: row.type_label ?? row.type,
    payload: JSON.parse(row.payload) as unknown,
    isRead: row.is_read === 1,
    createdAt: row.created_at,
  }));
}

/** 未读数：只数自己的未读站内通知。 */
export async function countUnreadNotifications(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0')
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * 标记已读：只允许动自己的通知（他人/不存在 → false，HTTP 层 404）。
 * 幂等：已读再点仍回 true。
 */
export async function markNotificationRead(
  db: D1Database,
  userId: string,
  notificationId: string,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .bind(notificationId, userId)
    .run();
  if (result.meta.changes > 0) {
    return true;
  }
  // 已读行 UPDATE 也命中（changes=1，SQLite 语义）；changes=0 只可能是 id 不存在或不属于该用户。
  return false;
}
