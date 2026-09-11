// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 内置身份 API 客户端（issue-A + pk1 决策 35：密码不出浏览器，线上只走盐和 R）：
 * - GET  /api/auth/methods                    登录方式探测（builtin 恒真，oidc 按配置）
 * - POST /api/auth/login                      用户名+密码登录（Cookie HttpOnly 自动管理）
 * - POST /api/setup/builtin-admin             setup 内置管理员开通（建号+封箱）
 * - POST /api/admin/members/:id/reset-password 管理员手动重置内置登录密码
 *
 * 错误口径（§6.5 三层透传，与 invite-api.ts 同构）：非 2xx 抛 Error，
 * message 优先取后端 JSON 的 error 字段（后端已给人话），status 挂 err.status
 * 供分档；网络异常统一 '网络不可用，请检查连接后重试'。
 */

import { generateSalt, deriveProof } from './pk1'

export interface AuthError extends Error {
  status: number
}

export interface AuthMethods {
  builtin: boolean
  oidc: boolean
}

export interface BuiltinAdminResult {
  ok: boolean
  user: { id: string; name: string; role: string }
}

function makeError(status: number, message: string): AuthError {
  const err = new Error(message) as AuthError
  err.status = status
  return err
}

/** 统一请求：网络异常/非 2xx 一律抛 AuthError（人话），2xx 回解析后 JSON。 */
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

/** GET /api/auth/methods：登录页按 oidc 显隐 SSO 按钮。 */
export function getAuthMethods(): Promise<AuthMethods> {
  return request<AuthMethods>('/api/auth/methods')
}

/** GET /api/auth/salt：登录先取盐（不存在用户回假盐，形状一致防枚举）。 */
async function fetchSalt(username: string): Promise<string> {
  const { salt } = await request<{ salt: string }>(`/api/auth/salt?username=${encodeURIComponent(username)}`)
  return salt
}

/** POST /api/auth/login：客户端派生 R 上送；成功即会话 Cookie 已下发（HttpOnly）。 */
export async function loginWithPassword(username: string, password: string): Promise<void> {
  const salt = await fetchSalt(username)
  const proof = await deriveProof(password, salt)
  await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, proof }),
  })
}

/** POST /api/setup/builtin-admin：创建内置管理员并封箱 setup（盐新生成）。 */
export async function createBuiltinAdmin(username: string, password: string): Promise<BuiltinAdminResult> {
  const salt = generateSalt()
  const proof = await deriveProof(password, salt)
  return request<BuiltinAdminResult>('/api/setup/builtin-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, salt, proof }),
  })
}

/** POST /api/admin/members/:id/reset-password：管理员设新密码（仅内置用户；盐新生成）。 */
export async function resetMemberPassword(id: string, password: string): Promise<void> {
  const salt = generateSalt()
  const proof = await deriveProof(password, salt)
  await request<void>(`/api/admin/members/${encodeURIComponent(id)}/reset-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ salt, proof }),
  })
}
