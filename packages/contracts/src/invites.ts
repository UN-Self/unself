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
 * `GET /api/invite/:token/status` 响应（#149）：三态 + 实例能力开关。
 * mailEnabled = instance_config 有无 `mail` 段（邮件轴能力唯一真相源）：
 * false 时邀请页不渲染邮箱字段、批准即激活（无开户动作）。
 */
export const InviteStatusResponseSchema = z.object({
  status: InvitePublicStatusSchema,
  mailEnabled: z.boolean(),
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
