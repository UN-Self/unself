// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 邮件轴错误分类（#115）：Stalwart provisioner 抛出的异常 → HTTP 状态码 + 人话 detail。
 * approve（invites）/ disable / enable（members）/ activate（激活，#150）共用同一状态码映射，
 * 判定依据 = 抛出的错误对象；动作前缀文案由调用方按各自语境拼接：
 * - MailProvisionerError 且 code === 'ACCOUNT_NOT_FOUND' → 409（可恢复冲突：Stalwart 侧无此账号）；
 * - 普通错误且 message 含 `HTTP 401/403`（JMAP 认证失败/权限不足）→ 502 + 检查 API Key 指引；
 * - 其它普通错误（网络/JMAP 形状等）→ 502，透传原 message（保持「<原前缀>：<原因>」可读性）。
 */
import { MailProvisionerError } from '@unself/contracts';

/** 分类结果：映射后的 HTTP 状态码与人话 detail。 */
export interface ClassifiedProvisionerFailure {
  status: 400 | 409 | 502;
  detail: string;
}

/** Stalwart 中无此邮箱账号（409 detail；<email> 由调用方按各自语境传入）。 */
export function accountNotFoundDetail(email: string): string {
  return `Stalwart 中无此邮箱账号（${email}），请管理员在 Stalwart 后台核对后重试`;
}

/** JMAP 认证失败/权限不足（502 detail）。 */
const AUTH_DETAIL = 'Stalwart 拒绝认证：请到 设置→邮件 检查 API Key（须挂管理员账号 + Inherit）';

/** #114 口径的裸原因（approve 开户失败 detail 的人话前缀）。 */
export function genericFailureDetail(reason: string): string {
  return `邮箱开户失败：${reason}，邀请保持待审批，可稍后重试批准`;
}

/**
 * activate 语境的失败外壳（#150）：动作前缀是「设置邮箱密码失败」，不是开户。
 * 两条出路文案由调用方按「令牌是否已回滚」二选一（#151）：
 * - 回滚成功（链接仍有救）→ activationRetryDetail；
 * - 回滚失败/无回滚（链接真烧了）→ activationFailureDetail。
 */
export function activationFailureDetail(reason: string): string {
  return `设置邮箱密码失败：${reason}。激活链接已失效，请回邀请页重新获取链接`;
}

/** activate 失败但令牌已回滚（#151）：链接未消费，用户可直接原地重试。 */
export function activationRetryDetail(reason: string): string {
  return `设置邮箱密码失败：${reason}。密码未被修改，链接仍有效，可直接重试`;
}

/**
 * 把 provisioner 抛出的错误分类成 { status, detail }。
 * detail 只给「原因」本身（409 人话 / 502 指引或透传）；「邮箱开户失败」这类动作前缀
 * 由调用方按各自语境拼接（invite approve 用 genericFailureDetail 保 #114 文案；
 * activate 用 activationFailureDetail 带 #150 的「回邀请页重新获取链接」出路）。
 */
export function classifyProvisionerFailure(error: unknown, email?: string): ClassifiedProvisionerFailure {
  if (error instanceof MailProvisionerError && error.code === 'ACCOUNT_NOT_FOUND') {
    return { status: 409, detail: accountNotFoundDetail(email ?? (error.message as string)) };
  }
  const reason = error instanceof Error ? error.message : String(error);
  if (/HTTP 40[13]/.test(reason)) {
    return { status: 502, detail: AUTH_DETAIL };
  }
  // Stalwart 密码策略拒绝（0.16.20 实测文案：`Password is too weak. Repeats like "abcabcabc"…`）
  // 属用户输入问题：400 人话，别把英文策略原文当 502 甩给用户（走查 #151 现场）。
  if (/password is too weak|too weak|password.*policy/i.test(reason)) {
    return {
      status: 400,
      detail: '密码强度不足：请使用更长、避免重复片段与常见词的密码（如两三个不相关的词拼起来）',
    };
  }
  return { status: 502, detail: reason };
}
