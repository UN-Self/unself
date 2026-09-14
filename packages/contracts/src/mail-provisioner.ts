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
 * 可选邮件系统的账户开通能力。失败一律由实现抛出；错误面 = 下方的 MailProvisionerError。
 */
export interface MailProvisioner {
  createAccount(input: CreateMailAccountInput): Promise<CreateMailAccountOutput>;
  disableAccount(input: MailAccountEmailInput): Promise<void>;
  enableAccount(input: MailAccountEmailInput): Promise<void>;
  resetPassword(input: ResetMailAccountPasswordInput): Promise<void>;
}

/** 邮箱开户错误码：只覆盖真实错误面中被调用方需要区分的两种（#141 自适配器上提）。 */
export type MailProvisionerErrorCode = 'ACCOUNT_EXISTS' | 'ACCOUNT_NOT_FOUND';

/** 携带错误码的开户失败；#18/#17 按需消费 code（#141 契约上提：核心层零适配器依赖）。 */
export class MailProvisionerError extends Error {
  readonly code: MailProvisionerErrorCode;

  constructor(code: MailProvisionerErrorCode, message: string) {
    super(message);
    this.name = 'MailProvisionerError';
    this.code = code;
  }
}

/**
 * 内存假实现（#20）：行为语义与 Stalwart 实现一致，给 #18/#22 集成测试用的标准件——
 * 记录调用历史（calls），不发任何网络请求。随错误契约住进 contracts，
 * 核心层测试无需为此依赖具体适配器包（#141）。
 */
export interface FakeMailCall {
  method: 'createAccount' | 'disableAccount' | 'enableAccount' | 'resetPassword';
  input: CreateMailAccountInput | MailAccountEmailInput | ResetMailAccountPasswordInput;
}

export interface FakeMailProvisioner extends MailProvisioner {
  /** 按序记录的全部调用。 */
  readonly calls: FakeMailCall[];
  /** 内存中的账户（email → 状态与密码），测试可读。 */
  readonly accounts: Map<
    string,
    { displayName: string; disabled: boolean; password: string }
  >;
}

export function createFakeMailProvisioner(): FakeMailProvisioner {
  const calls: FakeMailCall[] = [];
  const accounts = new Map<
    string,
    { displayName: string; disabled: boolean; password: string }
  >();

  const requireAccount = (
    email: string,
  ): { displayName: string; disabled: boolean; password: string } => {
    const account = accounts.get(email);
    if (!account) {
      throw new MailProvisionerError('ACCOUNT_NOT_FOUND', `邮箱账户 ${email} 不存在`);
    }
    return account;
  };

  return {
    calls,
    accounts,
    async createAccount(input: CreateMailAccountInput): Promise<CreateMailAccountOutput> {
      calls.push({ method: 'createAccount', input });
      const email = `${input.emailPrefix}@example.com`;
      if (accounts.has(email)) {
        throw new MailProvisionerError('ACCOUNT_EXISTS', `邮箱账户 ${email} 已存在`);
      }
      accounts.set(email, {
        displayName: input.displayName,
        disabled: false,
        password: 'fake-initial',
      });
      return { email };
    },
    async disableAccount(input: MailAccountEmailInput): Promise<void> {
      calls.push({ method: 'disableAccount', input });
      requireAccount(input.email).disabled = true;
    },
    async enableAccount(input: MailAccountEmailInput): Promise<void> {
      calls.push({ method: 'enableAccount', input });
      requireAccount(input.email).disabled = false;
    },
    async resetPassword(input: ResetMailAccountPasswordInput): Promise<void> {
      calls.push({ method: 'resetPassword', input });
      requireAccount(input.email).password = input.password;
    },
  };
}
