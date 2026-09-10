// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 公开邀请填表 / 激活 API 客户端（#18，无登录态）：
 * - GET  /api/invite/<token>   邀请链接读单条（pending 才有值，否则 404/410）
 * - POST /api/invite/<token>   提交申请三字段（displayName/emailPrefix/personalEmail）
 * - GET  /api/activate/<token> 激活链接读工作邮箱（未用未过期才有值）
 * - POST /api/activate/<token> 自设邮箱密码（SPEC §5.7：非工作台登录密码）
 *
 * 错误口径（§6.5 三层透传）：非 2xx 抛 Error，message 优先用后端 JSON 的
 * error 字段（本域后端已给人话），拿不到才回 '请求失败（<status>）'；
 * 网络异常统一回 '网络不可用，请检查连接后重试'。status 供调用方分档
 * （404/410 = 链接失效，人话仍由服务端提供）。不重写全局 fetch。
 */

/** 公开邀请域错误：message 一律人话，status 供分档（0 = 网络不可达）。 */
export interface InviteApiError extends Error {
  status: number
}

/** 邀请链接读取结果 + 申请提交字段（前后端同形；issue-A 增加内置注册 username/password，两者必须同时传）。 */
export interface InviteApplication {
  displayName: string
  emailPrefix: string
  personalEmail: string
  username?: string
  password?: string
}

function makeError(status: number, message: string): InviteApiError {
  const err = new Error(message) as InviteApiError
  err.status = status
  return err
}

/** 统一请求：网络异常/非 2xx 一律抛 InviteApiError（人话），2xx 回解析后 JSON。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init })
  } catch {
    throw makeError(0, '网络不可用，请检查连接后重试')
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    const serverMessage = typeof body?.error === 'string' ? body.error.trim() : ''
    throw makeError(res.status, serverMessage || `请求失败（${res.status}）`)
  }
  return (await res.json()) as T
}

/** GET /api/invite/<token>：链接仍可用时回申请三字段（新链接为空串）。 */
export function fetchInvite(token: string): Promise<InviteApplication> {
  return request<InviteApplication>(`/api/invite/${encodeURIComponent(token)}`)
}

/** POST /api/invite/<token>：提交申请表单（后端只接受 pending 行）。 */
export function submitInvite(token: string, application: InviteApplication): Promise<void> {
  return request<void>(`/api/invite/${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(application),
  })
}

/** GET /api/activate/<token>：激活页展示用工作邮箱（不消费令牌）。 */
export function fetchActivation(token: string): Promise<{ email: string }> {
  return request<{ email: string }>(`/api/activate/${encodeURIComponent(token)}`)
}

/** POST /api/activate/<token>：消费一次性令牌 → 设置邮箱密码；loginHint 为人话后续指引。 */
export function activateAccount(
  token: string,
  password: string,
): Promise<{ ok: boolean; loginHint: string }> {
  return request<{ ok: boolean; loginHint: string }>(`/api/activate/${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
}
