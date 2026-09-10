// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** 邀请在入职链路中的当前状态。 */
export const InviteStatusSchema = z.enum(['pending', 'approved', 'rejected', 'consumed', 'expired']);

export type InviteStatus = z.infer<typeof InviteStatusSchema>;

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
