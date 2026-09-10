// SPDX-License-Identifier: AGPL-3.0-only
//
// 真实投递集成测试：默认 skip，不阻塞 CI。
// 提供 SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM / SMTP_TO 后
// 手动发一封到指定收件箱，验证真实 465 隐式 TLS 送达。
// 运行：SMTP_HOST=… SMTP_USER=… SMTP_PASS=… SMTP_FROM=… SMTP_TO=… \
//       pnpm --filter @unself/mail-smtp test -- live.test.ts
import { describe, expect, it } from 'vitest';
import { connect as tlsConnect } from 'node:tls';
import { Readable, Writable } from 'node:stream';

import { sendMail } from '../src/smtp';
import type { Connect } from '../src/smtp';
import type { Socket } from 'cloudflare:sockets';

/**
 * node:tls 连接工厂：把 Node 的 TLS socket 适配成 cloudflare:sockets 的 Socket 面，
 * 让 sendMail 在纯 Node 环境也能走真实 465 隐式 TLS 投递（仅测试边界使用）。
 */
const nodeTlsConnect: Connect = (address) => {
  const socket = tlsConnect({ host: address.hostname, port: address.port, servername: address.hostname });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', () => {
      socket.removeListener('error', reject);
      resolve();
    });
    socket.once('error', reject);
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const adapter: Socket = {
    readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(socket) as WritableStream<Uint8Array>,
    opened,
    closed,
    close: async () => {
      socket.destroy();
    },
    startTls: () => {
      throw new Error('465 隐式 TLS 不用 startTls');
    },
  };
  return adapter;
};

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
