// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 邮件轴错误分类（#115；#189 B1 改结构化）：Stalwart provisioner 抛出的异常 → HTTP 状态码 + 人话 detail。
 * approve（invites）/ disable / enable（members）/ activate（激活，#150）共用同一状态码映射，
 * 判定依据 = 错误对象的结构化字段（`MailProvisionerError.code` / `httpStatus`），不再嗅探错误文案——
 * 适配器改文案不会让分类静默退化（#189 B1）：
 * - `ACCOUNT_NOT_FOUND` → 409（可恢复冲突：Stalwart 侧无此账号）；
 * - `AUTH_FAILED`（或 `httpStatus` 401/403）→ 502 + 检查 API Key 指引；
 * - `TIMEOUT`（配置时限内无响应，缺省 10s，#189 B5）→ 502 + 检查邮件服务器状态指引；
 * - `PASSWORD_REJECTED`（密码策略拒绝，属用户输入问题）→ 400 人话；
 * - 其它 → 502，透传原 message（保持「<原前缀>：<原因>」可读性）。
 * 兜底：非 MailProvisionerError 的裸 Error 仍按旧文案口径（HTTP 401/403、密码策略）分类，
 * 兼容尚未升级到结构化错误面的实现；一旦能拿到结构化字段就只看字段。
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

/** JMAP 超时（502 detail，#189 B5）：指向邮件服务器状态与网络，不写死秒数（时限可配）。 */
const TIMEOUT_DETAIL = 'Stalwart 未在时限内响应：请检查邮件服务器状态与网络后重试';

/**
 * Stalwart 密码策略拒绝（0.16.20 实测文案：`Password is too weak. Repeats like "abcabcabc"…`）
 * 属用户输入问题：400 人话，别把英文策略原文当 502 甩给用户（走查 #151 现场）。
 */
const WEAK_PASSWORD_DETAIL =
  '密码强度不足：请使用更长、避免重复片段与常见词的密码（如两三个不相关的词拼起来）';

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
  if (error instanceof MailProvisionerError) {
    if (error.code === 'ACCOUNT_NOT_FOUND') {
      return { status: 409, detail: accountNotFoundDetail(email ?? error.message) };
    }
    if (error.code === 'AUTH_FAILED' || error.httpStatus === 401 || error.httpStatus === 403) {
      return { status: 502, detail: AUTH_DETAIL };
    }
    if (error.code === 'TIMEOUT') {
      return { status: 502, detail: TIMEOUT_DETAIL };
    }
    if (error.code === 'PASSWORD_REJECTED') {
      return { status: 400, detail: WEAK_PASSWORD_DETAIL };
    }
    return { status: 502, detail: error.message };
  }
  // 未结构化的裸错误才走文案兜底（兼容旧实现）；存量实现升级到结构化错误面后自然走上面的分支。
  const reason = error instanceof Error ? error.message : String(error);
  if (/HTTP 40[13]/.test(reason)) {
    return { status: 502, detail: AUTH_DETAIL };
  }
  if (/password is too weak|too weak|password.*policy/i.test(reason)) {
    return { status: 400, detail: WEAK_PASSWORD_DETAIL };
  }
  return { status: 502, detail: reason };
}
