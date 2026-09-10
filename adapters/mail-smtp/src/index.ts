// SPDX-License-Identifier: AGPL-3.0-only
//
// @unself/mail-smtp 公共出口：SMTP 发信（465 隐式 TLS）、M1 中文模板、mail 段装配。
export { sendMail } from './smtp';
export type { SmtpConfig, MailMessage, Connect } from './smtp';
export { renderInviteResult, renderAccountReady, renderModuleToggled } from './templates';
export type { RenderedMail, InviteResultContext } from './templates';
export { createMailSenderFromConfig } from './config';
export type { MailConfig, MailSender } from './config';
