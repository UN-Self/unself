// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** 创建工作邮箱账户所需的信息。 */
export const CreateMailAccountInputSchema = z.object({
  emailPrefix: z.string(),
  displayName: z.string(),
});

export type CreateMailAccountInput = z.infer<typeof CreateMailAccountInputSchema>;

/** 创建账户后由适配器返回的工作邮箱地址。 */
export const CreateMailAccountOutputSchema = z.object({
  email: z.string().email(),
});

export type CreateMailAccountOutput = z.infer<typeof CreateMailAccountOutputSchema>;

/** 定位已有工作邮箱账户。 */
export const MailAccountEmailInputSchema = z.object({
  email: z.string().email(),
});

export type MailAccountEmailInput = z.infer<typeof MailAccountEmailInputSchema>;

/** 重设工作邮箱账户密码所需的信息。 */
export const ResetMailAccountPasswordInputSchema = MailAccountEmailInputSchema.extend({
  password: z.string(),
});

export type ResetMailAccountPasswordInput = z.infer<typeof ResetMailAccountPasswordInputSchema>;

/**
 * 可选邮件系统的账户开通能力。失败一律由实现抛出；错误面随真实适配器实现确定。
 */
export interface MailProvisioner {
  createAccount(input: CreateMailAccountInput): Promise<CreateMailAccountOutput>;
  disableAccount(input: MailAccountEmailInput): Promise<void>;
  enableAccount(input: MailAccountEmailInput): Promise<void>;
  resetPassword(input: ResetMailAccountPasswordInput): Promise<void>;
}
