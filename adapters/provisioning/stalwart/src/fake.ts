// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 假实现：内存 Map 模拟四方法，行为语义与 Stalwart 实现一致。
 * 给 #18/#22 集成测试用的标准件——记录调用历史（calls），不发任何网络请求。
 */

import type {
  CreateMailAccountInput,
  CreateMailAccountOutput,
  MailAccountEmailInput,
  MailProvisioner,
  ResetMailAccountPasswordInput,
} from '@unself/contracts';
import { MailProvisionerError } from './stalwart-provisioner.ts';

/** 假实现记录的一次调用（测试断言用）。 */
export interface FakeCall {
  method: 'createAccount' | 'disableAccount' | 'enableAccount' | 'resetPassword';
  input: CreateMailAccountInput | MailAccountEmailInput | ResetMailAccountPasswordInput;
}

export interface FakeMailProvisioner extends MailProvisioner {
  /** 按序记录的全部调用。 */
  readonly calls: FakeCall[];
  /** 内存中的账户（email → 状态与密码），测试可读。 */
  readonly accounts: Map<
    string,
    { displayName: string; disabled: boolean; password: string }
  >;
}

export function createFakeMailProvisioner(): FakeMailProvisioner {
  const calls: FakeCall[] = [];
  const accounts = new Map<string, { displayName: string; disabled: boolean; password: string }>();

  const requireAccount = (email: string): { displayName: string; disabled: boolean; password: string } => {
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
      accounts.set(email, { displayName: input.displayName, disabled: false, password: 'fake-initial' });
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
