// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 真实 Stalwart 集成测试：默认 skip（不阻塞 CI），
 * 提供环境变量后手动触发——四操作对真实例走一遍。
 *
 *   STALWART_BASE_URL=https://mail.example.com \
 *   STALWART_API_KEY=... \
 *   STALWART_DOMAIN=example.com \
 *   pnpm vitest run test/stalwart-live.test.ts
 */

import { describe, expect, it } from 'vitest';
import { createStalwartMailProvisioner } from '../src/stalwart-provisioner.ts';

const baseUrl = process.env.STALWART_BASE_URL;
const apiKey = process.env.STALWART_API_KEY;
const domain = process.env.STALWART_DOMAIN ?? '';

describe.skipIf(!baseUrl || !apiKey || !domain)('Stalwart live（真实实例）', () => {
  const provisioner = createStalwartMailProvisioner({ baseUrl: baseUrl!, apiKey: apiKey!, domain });
  const prefix = `unself-live-${Date.now().toString(36)}`;
  const email = `${prefix}@${domain}`;

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
});
