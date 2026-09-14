// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
  createFakeMailProvisioner,
  MailProvisionerError,
  type MailProvisioner,
} from '../src/index';
import {
  createFakeMailProvisioner as createFakeDirect,
  MailProvisionerError as MailProvisionerErrorDirect,
} from '../src/mail-provisioner';

/** #141 防回退守卫：错误契约必须从 contracts 公开出面，core-api 只认这个口。 */
describe('mail-provisioner 错误契约（#141）', () => {
  it('从包入口与模块文件导出同一构造器：code 挂类实例、name 固定、是 Error 子类', () => {
    expect(MailProvisionerErrorDirect).toBe(MailProvisionerError);
    const error = new MailProvisionerError('ACCOUNT_EXISTS', '邮箱账户 u1@example.com 已存在');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MailProvisionerError');
    expect(error.code).toBe('ACCOUNT_EXISTS');
    expect(error.message).toBe('邮箱账户 u1@example.com 已存在');
  });

  it('fake 抛出的错误可用 contracts 的 MailProvisionerError 捕获并读 code', async () => {
    const provisioner: MailProvisioner = createFakeDirect();
    const error = await provisioner
      .resetPassword({ email: 'no@example.com', password: 'x' })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(MailProvisionerError);
    expect((error as MailProvisionerError).code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('假实现行为基准：记录调用、开重复号抛 ACCOUNT_EXISTS', async () => {
    const provisioner: MailProvisioner = createFakeMailProvisioner();
    await provisioner.createAccount({ emailPrefix: 'u1', displayName: '一' });
    await expect(
      provisioner.createAccount({ emailPrefix: 'u1', displayName: '一' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });
    expect(createFakeMailProvisioner().calls).toEqual([]);
  });
});
