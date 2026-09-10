// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 管理端 API 客户端（#17 /admin 四页数据源）：
 * - GET /api/admin/members + disable/enable（#49）
 * - GET /api/admin/modules + POST toggle（#49，含停用模块全量）
 * - GET /api/admin/audit-log（#17 新端点，倒序 LIMIT 200）
 * - GET/PUT /api/admin/settings（#17 新端点，敏感值服务端脱敏）
 *
 * 错误约定：后端已有守卫与校验，前端不重复防御——失败抛 ApiError 给页面渲染错误卡。
 * request-id 透传（§6.5 三层错误透传）。
 */

/** 后端 JSON 错误（人话 + request id + 技术详情）。 */
export interface ApiError extends Error {
  status: number
  requestId?: string
  detail?: string
}

export function makeApiError(status: number, message: string, requestId?: string, detail?: string): ApiError {
  const err = new Error(message) as ApiError
  err.status = status
  err.requestId = requestId
  err.detail = detail
  return err
}

/** 统一请求：网络异常/非 2xx 一律抛 ApiError（人话 + request id），2xx 回解析后 JSON。 */
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init })
  } catch {
    throw makeApiError(0, '网络不可用，请检查连接后重试')
  }
  const requestId = res.headers.get('x-request-id') ?? undefined
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null
    throw makeApiError(res.status, `请求失败（${res.status}）`, requestId, body?.detail)
  }
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// 成员域（#49 契约）
// ---------------------------------------------------------------------------

export type MemberStatus = 'active' | 'disabled'

export interface AdminMember {
  id: string
  display_name: string | null
  email: string | null
  status: MemberStatus
  role: string
  created_at: string
}

export function fetchMembers(): Promise<AdminMember[]> {
  return request<AdminMember[]>('/api/admin/members')
}

/** 停用/启用成员（服务端联动邮箱账户 + 审计）。 */
export function setMemberStatus(id: string, status: Exclude<MemberStatus, 'active'> | 'active'): Promise<unknown> {
  return request(`/api/admin/members/${encodeURIComponent(id)}/${status === 'active' ? 'enable' : 'disable'}`, {
    method: 'POST',
  })
}

// ---------------------------------------------------------------------------
// 模块域（#49 契约，管理端含停用模块）
// ---------------------------------------------------------------------------

export interface AdminModule {
  id: string
  enabled: boolean
  version: string | null
}

export function fetchAdminModules(): Promise<AdminModule[]> {
  return request<AdminModule[]>('/api/admin/modules')
}

export function toggleModule(id: string, enabled: boolean): Promise<unknown> {
  return request(`/api/admin/modules/${encodeURIComponent(id)}/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

// ---------------------------------------------------------------------------
// 审计域（#17 新端点）
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: number
  actor: string
  action: string
  target: string | null
  created_at: string
}

export function fetchAuditLog(): Promise<AuditEntry[]> {
  return request<AuditEntry[]>('/api/admin/audit-log')
}

// ---------------------------------------------------------------------------
// 设置域（#17 新端点；敏感值 GET 恒 '***'，PUT '***'/空串 = 不修改）
// ---------------------------------------------------------------------------

/** 已配置密钥的固定占位符（与后端 MASK 一致）。 */
export const SECRET_MASK = '***'

export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret: string
  scope: string
}

export interface MailSettings {
  baseUrl: string
  apiKey: string
  domain: string
  host: string
  port: number | ''
  username: string
  password: string
  from: string
}

export interface InstanceSettings {
  oidc: OidcSettings
  mail: MailSettings
}

/** PUT body：字段可选；值为 '' / '***' / 缺省都表示不修改。 */
export type SettingsUpdate = {
  oidc?: Partial<{ [K in keyof OidcSettings]: string }>
  mail?: Partial<{ [K in keyof OidcSettings]: string }> & Partial<{ [K in keyof MailSettings]: string | number | '' }>
}

export function fetchSettings(): Promise<InstanceSettings> {
  return request<InstanceSettings>('/api/admin/settings')
}

export function saveSettings(update: SettingsUpdate): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  })
}

// ---------------------------------------------------------------------------
// 邀请域（#18 契约；令牌明文只在 createInvite 响应里出现一次）
// ---------------------------------------------------------------------------

export type AdminInviteStatus = 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired'

export interface AdminInvite {
  token_hash: string
  status: AdminInviteStatus
  personal_email: string
  email_prefix: string
  display_name: string
  created_at: string
  expires_at: string
}

/** 邀请列表（后端倒序，惰性过期已判）。 */
export function fetchInvites(): Promise<AdminInvite[]> {
  return request<AdminInvite[]>('/api/admin/invites')
}

/** 生成邀请链接（完整 URL 只在本响应出现，请立即复制）。 */
export function createInvite(expiresInDays: number): Promise<{ inviteUrl: string }> {
  return request<{ inviteUrl: string }>('/api/admin/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expiresInDays }),
  })
}

/** 批准申请：email 非空 = 已开户并发出激活链接；null = 弱化实例（首登按个人邮箱匹配）。 */
export function approveInvite(id: string): Promise<{ status: string; email: string | null }> {
  return request<{ status: string; email: string | null }>(
    `/api/admin/invites/${encodeURIComponent(id)}/approve`,
    { method: 'POST' },
  )
}

/** 拒绝申请（终态）。 */
export function rejectInvite(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/admin/invites/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
  })
}
