// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 真实 Stalwart 集成测试：默认 skip（不阻塞 CI），
 * 提供环境变量后手动触发——四操作对真实例走一遍。
 *
 *   STALWART_BASE_URL=https://mail.example.com \
 *   STALWART_API_KEY=... \
 *   STALWART_DOMAIN=example.com \
 *   pnpm vitest run test/stalwart-live.test.ts
 *
 * #189 复测项（B1/B2/B4）：认证失败结构化 code、显式权限账号 disable→enable 往返保真、
 * Inherit 账号仍回 Inherit、displayName 落 User.description。
 * 所有探测账号在本文件收尾时删除（afterAll），不留副作用。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { MailProvisionerError, createStalwartMailProvisioner } from '../src/stalwart-provisioner.ts';

const baseUrl = process.env.STALWART_BASE_URL;
const apiKey = process.env.STALWART_API_KEY;
const domain = process.env.STALWART_DOMAIN ?? '';

describe.skipIf(!baseUrl || !apiKey || !domain)('Stalwart live（真实实例）', () => {
  const provisioner = createStalwartMailProvisioner({ baseUrl: baseUrl!, apiKey: apiKey!, domain });
  const prefix = `unself-live-${Date.now().toString(36)}`;
  const email = `${prefix}@${domain}`;

  /** 直发 JMAP（读回账号权限/description 用；与适配器同一份凭证）。 */
  async function jmap(
    methodCalls: Array<[string, Record<string, unknown>, string]>,
  ): Promise<Array<[string, Record<string, unknown>, string]>> {
    const response = await fetch(`${baseUrl!.replace(/\/+$/, '')}/jmap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }),
    });
    if (!response.ok) {
      throw new Error(`JMAP HTTP ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as {
      methodResponses: Array<[string, Record<string, unknown>, string]>;
    };
    return body.methodResponses;
  }

  function responseBody(
    responses: Array<[string, Record<string, unknown>, string]>,
    callId: string,
  ): Record<string, unknown> {
    const found = responses.find(([, , id]) => id === callId);
    if (!found) {
      throw new Error(`JMAP 响应缺少调用 ${callId}`);
    }
    return found[1];
  }

  /** 按账号名（= 邮箱前缀）读回账号对象（含 permissions/description）。 */
  async function getAccount(name: string): Promise<Record<string, unknown>> {
    const responses = await jmap([
      ['x:Account/query', { filter: { name } }, 'q'],
      ['x:Account/get', { '#ids': { resultOf: 'q', name: 'x:Account/query', path: '/ids' } }, 'g'],
    ]);
    const list = (responseBody(responses, 'g')['list'] as Array<Record<string, unknown>> | undefined) ?? [];
    const account = list[0];
    if (!account) {
      throw new Error(`Stalwart 中找不到账号 ${name}`);
    }
    return account;
  }

  /** 显式设置 permissions（模拟管理员在 Stalwart 后台单独配过的账号）。 */
  async function setPermissions(accountId: string, permissions: Record<string, unknown>): Promise<void> {
    const responses = await jmap([['x:Account/set', { update: { [accountId]: { permissions } } }, 'u']]);
    expect(responseBody(responses, 'u')['updated']).toEqual({ [accountId]: null });
  }

  /** 删探测账号（用完即删，不留副作用）。 */
  async function destroyAccount(accountId: string): Promise<void> {
    const responses = await jmap([['x:Account/set', { destroy: [accountId] }, 'd']]);
    expect(responseBody(responses, 'd')['destroyed']).toEqual([accountId]);
  }

  afterAll(async () => {
    // 清理四方法用例的探测账号（其余用例各自收尾删除）
    const account = await getAccount(prefix).catch(() => null);
    if (account) {
      await destroyAccount(account['id'] as string);
    }
  });

  it('createAccount → disableAccount → enableAccount → resetPassword', async () => {
    const created = await provisioner.createAccount({ emailPrefix: prefix, displayName: 'Unself 真实验收' });
    expect(created.email).toBe(email);

    await expect(provisioner.disableAccount({ email })).resolves.toBeUndefined();
    await expect(provisioner.enableAccount({ email })).resolves.toBeUndefined();
    await expect(provisioner.resetPassword({ email, password: 'Live-Check-2026' })).resolves.toBeUndefined();
  }, 30_000);

  it('重复 createAccount → ACCOUNT_EXISTS', async () => {
    await expect(provisioner.createAccount({ emailPrefix: prefix, displayName: '重复' })).rejects.toMatchObject({
      code: 'ACCOUNT_EXISTS',
    });
  }, 30_000);

  it('查无此人 → ACCOUNT_NOT_FOUND', async () => {
    await expect(provisioner.disableAccount({ email: `no-such-${Date.now()}@${domain}` })).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
  }, 30_000);

  it('B1：错误 API key → 结构化 AUTH_FAILED（含 httpStatus），不靠文案判定', async () => {
    const wrongKey = createStalwartMailProvisioner({
      baseUrl: baseUrl!,
      apiKey: 'definitely-not-a-valid-key',
      domain,
    });
    const error = await wrongKey.enableAccount({ email }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MailProvisionerError);
    expect((error as MailProvisionerError).code).toBe('AUTH_FAILED');
    expect([401, 403]).toContain((error as MailProvisionerError).httpStatus);
  }, 30_000);

  it('B4：displayName 落到 Stalwart User.description（与假实现语义一致）', async () => {
    const name = `${prefix}-b4`;
    const displayName = `真实验收-${name}`;
    await provisioner.createAccount({ emailPrefix: name, displayName });
    const account = await getAccount(name);
    expect(account['description']).toBe(displayName);
    await destroyAccount(account['id'] as string);
  }, 30_000);

  it('B2：显式权限账号 disable→enable 后原 enabledPermissions 仍在；Inherit 账号仍回 Inherit', async () => {
    // 1) 显式权限账号（issue #189 真机实测的账号形状：Merge + enabled.authenticate）
    const explicitName = `${prefix}-b2a`;
    const explicitEmail = `${explicitName}@${domain}`;
    await provisioner.createAccount({ emailPrefix: explicitName, displayName: 'B2 显式权限' });
    const explicit = await getAccount(explicitName);
    const explicitId = explicit['id'] as string;
    const explicitPermissions = {
      '@type': 'Merge',
      enabledPermissions: { authenticate: true, jmapEmailGet: true },
      disabledPermissions: {},
    };
    await setPermissions(explicitId, explicitPermissions);

    await provisioner.disableAccount({ email: explicitEmail });
    const disabled = (await getAccount(explicitName))['permissions'] as Record<string, unknown>;
    // 停用生效（authenticate 进 disabled），且显式权限没被抹平
    expect(disabled['enabledPermissions']).toEqual({ authenticate: true, jmapEmailGet: true });
    expect(disabled['disabledPermissions']).toMatchObject({ authenticate: true });

    await provisioner.enableAccount({ email: explicitEmail });
    // 往返后与原始显式权限一致——旧实现在这里回 {@type: Inherit}（整表抹平）
    expect((await getAccount(explicitName))['permissions']).toEqual(explicitPermissions);
    await destroyAccount(explicitId);

    // 2) Inherit 账号：disable→enable 后仍回 Inherit（验收口径）
    const inheritName = `${prefix}-b2b`;
    const inheritEmail = `${inheritName}@${domain}`;
    await provisioner.createAccount({ emailPrefix: inheritName, displayName: 'B2 Inherit' });
    const inherit = await getAccount(inheritName);
    const inheritId = inherit['id'] as string;
    expect(inherit['permissions']).toEqual({ '@type': 'Inherit' });

    await provisioner.disableAccount({ email: inheritEmail });
    await provisioner.enableAccount({ email: inheritEmail });
    expect((await getAccount(inheritName))['permissions']).toEqual({ '@type': 'Inherit' });
    await destroyAccount(inheritId);
  }, 60_000);
});
