// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** 邀请在入职链路中的当前状态。 */
export const InviteStatusSchema = z.enum(['pending', 'approved', 'rejected', 'consumed', 'expired']);

export type InviteStatus = z.infer<typeof InviteStatusSchema>;

/**
 * 公开邀请页三态（#134）：对申请人只暴露这三个语义，
 * expired/rejected 是管理侧事实，对外一律「已失效」（不泄露状态机细节）。
 */
export const InvitePublicStatusSchema = z.enum(['pending', 'approved', 'activated']);

export type InvitePublicStatus = z.infer<typeof InvitePublicStatusSchema>;

/**
 * `GET /api/invite/:token/status` 响应（#149/#340）：三态 + 实例能力双旗。
 * mailEnabled = 开户轴（isMailEnabled 口径）：mail_stalwart 段 enabled === true；
 * smtpEnabled = 发信轴（isSmtpEnabled 口径，#340）：mail_smtp 段 enabled === true。
 * 两旗均 fail-closed（缺段/非 true 即 false）。消费口径（决策 #98）：
 * emailPrefix 必填 ⟷ mailEnabled；personalEmail 必填 ⟷ mailEnabled || smtpEnabled
 * （SMTP 结果邮件收件人 + OIDC 首登消费邀请/通知归属的身份锚）。
 */
export const InviteStatusResponseSchema = z.object({
  status: InvitePublicStatusSchema,
  mailEnabled: z.boolean(),
  smtpEnabled: z.boolean(),
});

export type InviteStatusResponse = z.infer<typeof InviteStatusResponseSchema>;

/** 一次性、限期邀请记录。 */
export const InviteSchema = z.object({
  tokenHash: z.string(),
  status: InviteStatusSchema,
  personalEmail: z.string().email(),
  emailPrefix: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export type Invite = z.infer<typeof InviteSchema>;

const inviteTransitions: Record<InviteStatus, InviteStatus[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['consumed', 'expired'],
  rejected: [],
  consumed: [],
  expired: [],
};

/** 仅允许邀请按入职链路向终态前进。 */
export function assertInviteTransition(from: InviteStatus, to: InviteStatus): void {
  if (!inviteTransitions[from].includes(to)) {
    throw new Error(`Invalid invite transition: ${from} -> ${to}`);
  }
}
