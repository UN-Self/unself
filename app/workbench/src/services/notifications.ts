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
 * - 落库与邮件渲染分离（#188 S4）：邮件拿完整 payload 渲染，站内 payload 先按
 *   PAYLOAD_SCOPES 脱敏再持久化——一次性激活链接/令牌不进库，只留「链接已生成」标记。
 */
import {
  createMailSenderFromConfig,
  renderAccountReady,
  renderInviteResult,
  renderModuleToggled,
  type MailSender,
} from '@unself/mail-smtp';

import { audit } from './audit';
import { parseMailSection } from './members';

/** 站内/邮件收件人口径：已建档用户 / 待建档受邀邮箱 / 全员广播 / 全体管理员。 */
export type NotificationRecipient =
  | { userId: string; email?: string }
  | { invitedEmail: string }
  | { broadcast: true }
  | { admins: true };

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

/** 解析收件人：broadcast 查全体 active（含操作者本人）；admins 查 active 管理员；
 *  invitedEmail 悬挂；userId 取传入或库中邮箱。 */
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
  if ('admins' in recipient) {
    const rows = await db
      .prepare("SELECT id, email FROM users WHERE status = 'active' AND role = 'admin'")
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

/**
 * 站内 payload 字段面（#188 S4）：列出「只给邮件」的字段与脱敏标记。
 * - emailOnly：只在邮件渲染时可见，站内持久化前剥掉（一次性令牌/激活链接不落库）；
 * - inAppMarker：剥字段后补进站内 payload 的脱敏标记，让站内一眼看出
 *   「链接已生成但本体不在库里」；
 * - 未登记的类型 = 全字段两边一致（新类型无须登记即保持今天的行为）。
 * 新增「只给邮件」的敏感字段时只改这张表，别在调用方手工裁剪 payload
 * （裁剪点在服务层，全部触发路径共用同一口径）。
 */
interface PayloadScope {
  emailOnly: readonly string[];
  inAppMarker?: Record<string, unknown>;
}

const PAYLOAD_SCOPES: Record<string, PayloadScope> = {
  account_ready: { emailOnly: ['activateUrl'], inAppMarker: { activateLinkGenerated: true } },
};

/**
 * 站内持久化 payload：剥掉该类型声明为 emailOnly 的字段，再补脱敏标记。
 * 未登记类型原样返回（同一对象引用）；不改动入参——邮件渲染随后仍用完整 payload。
 */
function inAppPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const scope = PAYLOAD_SCOPES[type];
  if (!scope) {
    return payload;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!scope.emailOnly.includes(key)) {
      sanitized[key] = value;
    }
  }
  return { ...sanitized, ...scope.inAppMarker };
}

/**
 * 按类型渲染邮件：已知类型走 mail-smtp 模板，未来类型用类型表 template 作主题、正文留空。
 * 入参 payload 是调用方原样传入的完整值（含只给邮件的字段，如 account_ready 的 activateUrl）。
 */
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
 * 2. in_app=1 → 逐收件人写站内行（payload 经 inAppPayload 脱敏后 JSON 存储）；
 * 3. email=1 且有 sender → 逐收件人用完整 payload 渲染发信，单封失败各自落审计，
 *    不影响站内与其他收件人。
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
        .bind(
          crypto.randomUUID(),
          target.userId,
          target.invitedEmail,
          type,
          JSON.stringify(inAppPayload(type, payload)),
        )
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

/** SMTP 装配注入面（#18 测试口）：外部边界替身只在此层；缺省 = 真 SMTP。 */
export type CreateMailSender = (mailConfig: Record<string, unknown>) => MailSender | null;

/**
 * 从 instance_config 的 mail 段装配发信口：无段/enabled === false → null（弱化实例静默降级）。
 * 段解析复用 members.ts 的 parseMailSection（唯一副本口径）；#167 起开关轴与
 * isMailEnabled/configuredMailProvisioner 同口径：关闭即不装配 sender，也不碰工厂。
 * 字段不完整由 createMailSenderFromConfig 判定，同样回 null。
 */
export async function configuredMailSender(
  db: D1Database,
  createMailSender: CreateMailSender = createMailSenderFromConfig,
): Promise<MailSender | null> {
  const row = await db
    .prepare("SELECT value FROM instance_config WHERE key = 'mail'")
    .bind()
    .first<{ value: string }>();
  if (!row) {
    return null;
  }
  const section = parseMailSection(row.value);
  // 开关关闭 = 弱化实例：整个发信轴不装配（老数据无 enabled 字段 → 缺省开启，行为不变）。
  if (section.enabled === false) {
    return null;
  }
  return createMailSender(section);
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
