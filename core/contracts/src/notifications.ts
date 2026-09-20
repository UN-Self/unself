// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** 由核心数据化配置的通知类型。 */
export const NotificationTypeSchema = z.object({
  type: z.string(),
  template: z.string(),
  inApp: z.boolean(),
  email: z.boolean(),
});

export type NotificationType = z.infer<typeof NotificationTypeSchema>;

/** 发给已建档用户或待建档受邀人的通知。 */
export const NotificationSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  invitedEmail: z.string().email().nullable(),
  type: z.string(),
  payload: z.unknown(),
  isRead: z.boolean(),
  createdAt: z.string(),
});

export type Notification = z.infer<typeof NotificationSchema>;
