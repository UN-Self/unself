// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sendMail } from '../src/smtp';
import type { SmtpConfig } from '../src/smtp';

const CONFIG: SmtpConfig = {
  host: 'mail.example.com',
  port: 465,
  username: 'no-reply@example.com',
  password: 'secret',
  from: 'no-reply@example.com',
};

const MESSAGE = {
  to: 'newcomer@example.com',
  subject: '欢迎加入 Unself',
  text: '第一行\n第二行带中文与 emoji 🎉',
};

/** 用真实 Web Streams 造的 socket mock：按脚本下发应答，捕获客户端写入。 */
function scriptedSocket(replies: string[]) {
  const written: string[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(replies.join('\r\n') + '\r\n'));
      controller.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(decoder.decode(chunk));
    },
  });
  const socket = {
    readable,
    writable,
    opened: Promise.resolve(),
    closed: Promise.resolve(),
    close: async () => {},
    startTls: () => {
      throw new Error('单测不走 STARTTLS');
    },
  };
  return {
    socket,
    connect: () => socket,
    written: () => written.join(''),
  };
}

function happyReplies(): string[] {
  return [
    '220 mail.example.com ESMTP ready',
    '250-mail.example.com', // 多行 EHLO：延续行
    '250-PIPELINING',
    '250 8BITMIME',
    '334 VXNlcm5hbWU6', // "Username:"
    '334 UGFzc3dvcmQ6', // "Password:"
    '235 2.7.0 Go ahead',
    '250 2.1.0 OK',
    '250 2.1.5 OK',
    '354 Go ahead',
    '250 2.0.0 Queued',
  ];
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-12T08:00:00Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sendMail（465 隐式 TLS）', () => {
  it('按 EHLO→AUTH→MAIL→RCPT→DATA→QUIT 序列投递，中文 Subject 走 encoded-word、正文走 base64', async () => {
    const fake = scriptedSocket(happyReplies());
    await sendMail(CONFIG, MESSAGE, fake.connect);

    const written = fake.written();
    // 命令序列：AUTH LOGIN 后依次是 base64(用户名)、base64(密码)
    expect(written.startsWith(
      'EHLO example.com\r\n' +
        'AUTH LOGIN\r\n' +
        `${Buffer.from(CONFIG.username).toString('base64')}\r\n` +
        `${Buffer.from(CONFIG.password).toString('base64')}\r\n` +
        `MAIL FROM:<${CONFIG.from}>\r\n` +
        `RCPT TO:<${MESSAGE.to}>\r\n` +
        'DATA\r\n',
    )).toBe(true);
    expect(written.endsWith('\r\n.\r\nQUIT\r\n')).toBe(true);

    // DATA 载荷 = 头 + 空行 + base64 正文
    const dataAt = written.indexOf('DATA\r\n') + 'DATA\r\n'.length;
    const payload = written.slice(dataAt, written.length - '\r\n.\r\nQUIT\r\n'.length);
    const [head = '', body = ''] = payload.split('\r\n\r\n');
    expect(head.split('\r\n')).toEqual([
      'From: no-reply@example.com',
      'To: newcomer@example.com',
      `Subject: =?utf-8?B?${Buffer.from(MESSAGE.subject).toString('base64')}?=`,
      'Date: Sat, 12 Sep 2026 08:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
    ]);

    // 正文 base64 折行 ≤76，解码回原文
    const bodyLines = body.split('\r\n');
    for (const line of bodyLines) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(Buffer.from(bodyLines.join(''), 'base64').toString('utf8')).toBe(MESSAGE.text);
  });

  it('AUTH 认证失败（535）→ 人话 Error 含状态码，且不再发出 MAIL FROM', async () => {
    const fake = scriptedSocket([
      '220 mail.example.com ESMTP ready',
      '250 mail.example.com',
      '334 VXNlcm5hbWU6',
      '334 UGFzc3dvcmQ6',
      '535 5.7.8 Authentication credentials invalid',
    ]);
    await expect(sendMail(CONFIG, MESSAGE, fake.connect)).rejects.toThrow(
      'SMTP 认证失败（535）',
    );
    expect(fake.written()).not.toContain('MAIL FROM');
  });

  it('收件人被拒（550）→ 人话 Error 含状态码', async () => {
    const fake = scriptedSocket([
      '220 mail.example.com ESMTP ready',
      '250 mail.example.com',
      '334 VXNlcm5hbWU6',
      '334 UGFzc3dvcmQ6',
      '235 2.7.0 Go ahead',
      '250 2.1.0 OK',
      '550 5.1.1 no such user',
    ]);
    await expect(sendMail(CONFIG, MESSAGE, fake.connect)).rejects.toThrow(
      'SMTP 投递被拒：收件人被拒（550）',
    );
  });

  it('连接失败 → 人话 Error 含主机与端口', async () => {
    const connect = () => {
      throw new Error('dial tcp: lookup mail.example.com: no such host');
    };
    await expect(sendMail(CONFIG, MESSAGE, connect)).rejects.toThrow(
      'SMTP 连接失败：无法连接 mail.example.com:465',
    );
  });

  it('问候语非 220 → 人话 Error 含状态码', async () => {
    const fake = scriptedSocket(['554 mail.example.com go away']);
    await expect(sendMail(CONFIG, MESSAGE, fake.connect)).rejects.toThrow(
      'SMTP 连接失败：服务器问候异常（554）',
    );
  });
});
