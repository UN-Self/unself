// SPDX-License-Identifier: AGPL-3.0-only
//
// 真实投递集成测试：默认 skip，不阻塞 CI。
// 提供 SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM / SMTP_TO 后
// 手动发一封到指定收件箱，验证真实 465 隐式 TLS 送达。
// 运行：SMTP_HOST=… SMTP_USER=… SMTP_PASS=… SMTP_FROM=… SMTP_TO=… \
//       pnpm --filter @unself/mail-smtp test -- live.test.ts
import { describe, expect, it } from 'vitest';
import { sendMail } from '../src/smtp';
import { nodeTlsConnect } from './node-tls-connect';
const env = process.env;

describe.skipIf(!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.SMTP_FROM || !env.SMTP_TO)(
  '真实 SMTP 投递（手动）',
  () => {
    it('通过真实 465 隐式 TLS 送达一封中文邮件', async () => {
      const config = {
        host: env.SMTP_HOST!,
        port: Number(env.SMTP_PORT ?? 465),
        username: env.SMTP_USER!,
        password: env.SMTP_PASS!,
        from: env.SMTP_FROM!,
      };
      const to = env.SMTP_TO!;
      await expect(
        sendMail(config, {
          to,
          subject: 'unself mail-smtp 投递测试',
          text: '这是一封中文测试邮件。',
        }, nodeTlsConnect),
      ).resolves.toBeUndefined();
    });
  },
);
