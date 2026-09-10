// SPDX-License-Identifier: AGPL-3.0-only
//
// 装配函数（#48 拍板口径）：mail 段缺失/不完整 → 返回 null（弱化实例静默降级），
// 不抛错。凭证明文存 core D1 instance_config mail 段（2026-09-10 拍板的已接受缺口）。
import { sendMail } from './smtp';
import type { Connect, MailMessage } from './smtp';

/** 实例配置 mail 段（#19 从 core D1 instance_config 读出后传入）。 */
export interface MailConfig {
  host?: unknown;
  port?: unknown;
  username?: unknown;
  password?: unknown;
  from?: unknown;
}

/** 装配成功后的发信口（#19 消费）。 */
export interface MailSender {
  send(message: MailMessage): Promise<void>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asPort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 读 mail 段装配发信口；段缺失或任一字段不完整 → null（静默降级，不抛错）。
 */
export function createMailSenderFromConfig(
  mailConfig: MailConfig | null | undefined,
  connectFn?: Connect,
): MailSender | null {
  const host = asString(mailConfig?.host);
  const port = asPort(mailConfig?.port);
  const username = asString(mailConfig?.username);
  const password = asString(mailConfig?.password);
  const from = asString(mailConfig?.from);
  if (!host || !port || !username || !password || !from) {
    return null;
  }
  const smtpConfig = { host, port, username, password, from };
  return {
    send: (message) => sendMail(smtpConfig, message, connectFn),
  };
}
