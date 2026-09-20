// SPDX-License-Identifier: AGPL-3.0-only
//
// M1 通知邮件模板（唯一消费方 #19 通知中心）。纯文本、中文硬编码、{name} 风格有限替换；
// 缺变量给空串，不抛错（拍板口径）。不做模板引擎/多语言框架。

/** 渲染产物：subject/text 直接喂给 sendMail。 */
export interface RenderedMail {
  subject: string;
  text: string;
}

/** 邀请审批结果上下文（缺省字段渲染为空串）。 */
export interface InviteResultContext {
  /** 受邀人称呼。 */
  name?: string;
  /** 审批管理员称呼。 */
  approver?: string;
}

/** 有限变量替换：只认 {word}，缺变量给空串，不抛错。 */
function fill(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '');
}

/** 邀请申请结果：approved=true 批准 / false 拒绝。 */
export function renderInviteResult(
  approved: boolean,
  context: InviteResultContext = {},
): RenderedMail {
  const vars = { name: context.name ?? '', approver: context.approver ?? '' };
  if (approved) {
    return {
      subject: fill('【Unself】{name} 的加入申请已通过', vars),
      text: fill(
        '{name}，你好！\n\n你提交的加入申请已由管理员 {approver} 批准，账号即日可用。\n请使用团队的 OIDC 账号登录工作台开始使用。\n\n—— Unself 工作台',
        vars,
      ),
    };
  }
  return {
    subject: fill('【Unself】{name} 的加入申请未通过', vars),
    text: fill(
      '{name}，你好！\n\n经管理员 {approver} 审核，你提交的加入申请未获批准。\n如有疑问，请直接联系团队管理员。\n\n—— Unself 工作台',
      vars,
    ),
  };
}

/** 账号已开通：邮件地址 + 一次性激活链接。 */
export function renderAccountReady(email: string, activateUrl: string): RenderedMail {
  const vars = { email, activateUrl };
  return {
    subject: '【Unself】你的账号已开通',
    text: fill(
      '你好！\n\n你的邮箱账号 {email} 已开通。\n请点击下面的链接完成激活（一次性、限时有效）：\n{activateUrl}\n\n若非你本人操作，请忽略本邮件。\n\n—— Unself 工作台',
      vars,
    ),
  };
}

/** 模块启停通知。 */
export function renderModuleToggled(moduleName: string, enabled: boolean): RenderedMail {
  const state = enabled ? '已启用' : '已停用';
  const vars = { moduleName, state };
  return {
    subject: fill('【Unself】模块「{moduleName}」{state}', vars),
    text: fill(
      '你好！\n\n模块「{moduleName}」{state}。\n工作台导航与相关功能将随之更新。\n\n—— Unself 工作台',
      vars,
    ),
  };
}
