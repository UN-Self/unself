// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 登录失败人话映射（#60 T4 短错误码 → §6.5 人话）：
 * core-api callback 失败只暴露固定枚举（oidc_state_mismatch / oidc_token_expired /
 * oidc_provider_error / oidc_failed），此处译为成员可读文案；
 * 未知/缺省错误码回退通用文案，不暴露内部细节。
 */

export const LOGIN_ERROR_TITLE = '登录暂时不可用'

const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  oidc_state_mismatch: '登录状态校验失败（state 不一致），请重新发起登录。',
  oidc_token_expired: '登录凭证已过期，请重新发起登录。',
  oidc_provider_error: '身份源返回异常，请稍后重试；若持续失败请联系管理员。',
  oidc_failed: '登录校验失败，请联系管理员检查身份源配置。',
}

/** 路由 error 参数 → 人话文案；无参数返回 null（不显示异常卡）。 */
export function humanizeLoginError(error: unknown): { title: string; message: string } | null {
  if (typeof error !== 'string' || error.length === 0) return null
  return {
    title: LOGIN_ERROR_TITLE,
    message: LOGIN_ERROR_MESSAGES[error] ?? '登录校验失败，请稍后重试；若持续失败请联系管理员。',
  }
}
