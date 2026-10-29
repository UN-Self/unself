// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 管理端 API 客户端（#17 /admin 四页数据源）：
 * - GET /api/admin/members + disable/enable（#49）
 * - GET /api/admin/modules + POST toggle（#49，含停用模块全量）
 * - GET /api/admin/audit-log（#17 新端点，倒序 LIMIT 200）
 * - 设置域（#340 分域）：GET /api/admin/settings 回 { oidc, stalwart, smtp }；
 *   PUT 各段独立（/api/admin/settings 只收 oidc，mail-stalwart / mail-smtp 各碰各键）；
 *   测试连接候选化（POST mail-stalwart/test、mail-smtp/test，发表单草稿不落库）。
 *   敏感值服务端脱敏（GET 恒 '***'）。
 *
 * 错误约定：后端已有守卫与校验，前端不重复防御——失败抛 ApiError 给页面渲染错误卡。
 * request-id 透传（§6.5 三层错误透传）。
 * 传输/错误构造统一走 lib/api-client（#142）：本文件只留端点函数与域类型。
 * #142 错误文案保持原状：admin 域固定 `请求失败（<status>）`（statusOnly 策略），
 * 不吸收后端 error 字段（页面有 detail 行，行为零变化）。
 */

import { makeApiError, request, statusOnlyMessage, type ApiError } from './api-client'

export type { ApiError }
export { makeApiError }

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
  return request<AdminMember[]>('/api/admin/members', undefined, { messagePolicy: statusOnlyMessage })
}

/** 停用/启用成员（服务端联动邮箱账户 + 审计）。 */
export function setMemberStatus(id: string, status: Exclude<MemberStatus, 'active'> | 'active'): Promise<unknown> {

  return request(`/api/admin/members/${encodeURIComponent(id)}/${status === 'active' ? 'enable' : 'disable'}`, {
    method: 'POST',
  }, { messagePolicy: statusOnlyMessage })
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
  return request<AdminModule[]>('/api/admin/modules', undefined, { messagePolicy: statusOnlyMessage })
}

export function toggleModule(id: string, enabled: boolean): Promise<unknown> {
  return request(`/api/admin/modules/${encodeURIComponent(id)}/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }, { messagePolicy: statusOnlyMessage })
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
  return request<AuditEntry[]>('/api/admin/audit-log', undefined, { messagePolicy: statusOnlyMessage })
}

// ---------------------------------------------------------------------------
// 设置域（#340 分域：OIDC / 邮箱管理 Stalwart / 通知发信 SMTP 三段独立。
// 邮件段写侧空串语义见决策 #100；OIDC 空串仍是不修改）
// ---------------------------------------------------------------------------

/** 已配置密钥的固定占位符（与后端 MASK 一致）。 */
export const SECRET_MASK = '***'

export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret: string
  scope: string
}

export interface StalwartSettings {
  /** 邮箱管理开关（D5 fail-closed：装配只认 enabled === true；GET 恒回 boolean）。 */
  enabled: boolean
  baseUrl: string
  apiKey: string
  domain: string
  /** 应用密码说明页跳转目标（#168 展示用；#184 起设置页可直填，仍走本字段）。空 = 后端按 domain 推导 https://mail.<domain>。 */
  portalUrl: string
}

export interface SmtpSettings {
  /** 通知发信开关（D5 fail-closed：装配只认 enabled === true；GET 恒回 boolean）。 */
  enabled: boolean
  host: string
  /** 端口正整数；'' = 未配置。PUT 传 '' = 清空（决策 #100）。 */
  port: number | ''
  username: string
  password: string
  from: string
}

/** GET /api/admin/settings 的对外形状（#340 三段分域，与 core routes/settings.ts InstanceSettings 对齐）。 */
export interface InstanceSettings {
  oidc: OidcSettings
  stalwart: StalwartSettings
  smtp: SmtpSettings
}

/**
 * PUT body：各段独立，字段可选。
 * OIDC：空串 / `***` / 缺键 = 不修改，不能清空。
 * 邮件段（决策 #100）：缺键 = 保持；普通文本空串 = 删键（portalUrl 先 trim，纯空白也删）；
 * port 空串 = 删键；密钥空串 / `***` = 保持（无清空入口）。
 * enabled 恒显式布尔（D5）：邮件段 PUT 缺 enabled → 400。
 */
export type OidcSettingsUpdate = Partial<{ [K in keyof OidcSettings]: string }>
export type StalwartSettingsUpdate = Partial<{ [K in keyof StalwartSettings]: StalwartSettings[K] }>
export type SmtpSettingsUpdate = Partial<{ [K in keyof SmtpSettings]: SmtpSettings[K] }>

export function fetchSettings(): Promise<InstanceSettings> {
  return request<InstanceSettings>('/api/admin/settings', undefined, { messagePolicy: statusOnlyMessage })
}

/** 编辑 OIDC 登录段：只发 { oidc }，不再夹带任何邮件字段（#340）。 */
export function saveOidcSettings(update: OidcSettingsUpdate): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oidc: update }),
  }, { messagePolicy: statusOnlyMessage })
}

/** 编辑邮箱管理（Stalwart 开户）段：整键读-改-写只碰 mail_stalwart；D5 校验失败后端回 400 + 人话 detail。 */
export function saveStalwartSettings(update: StalwartSettingsUpdate): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/admin/settings/mail-stalwart', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  }, { messagePolicy: statusOnlyMessage })
}

/** 编辑通知发信（SMTP）段：整键读-改-写只碰 mail_smtp；D5 校验失败后端回 400 + 人话 detail。 */
export function saveSmtpSettings(update: SmtpSettingsUpdate): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/admin/settings/mail-smtp', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  }, { messagePolicy: statusOnlyMessage })
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
  return request<AdminInvite[]>('/api/admin/invites', undefined, { messagePolicy: statusOnlyMessage })
}

/** 生成邀请链接（完整 URL 只在本响应出现，请立即复制）。 */
export function createInvite(expiresInDays: number): Promise<{ inviteUrl: string }> {
  return request<{ inviteUrl: string }>('/api/admin/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expiresInDays }),
  }, { messagePolicy: statusOnlyMessage })
}

/** 批准申请：email 非空 = 已开户并发出激活链接；null = 弱化实例（首登按个人邮箱匹配）。 */
export function approveInvite(id: string): Promise<{ status: string; email: string | null }> {
  return request<{ status: string; email: string | null }>(
    `/api/admin/invites/${encodeURIComponent(id)}/approve`,
    { method: 'POST' },
    { messagePolicy: statusOnlyMessage },
  )
}

/** 拒绝申请（终态）。 */
export function rejectInvite(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/admin/invites/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
  }, { messagePolicy: statusOnlyMessage })
}

/** 单轴测试结果：ok + 人话 detail（结果卡直显，不含任何密钥明文）。 */
export interface MailTestResult {
  ok: boolean
  detail: string
}

/** 邮箱管理（Stalwart）候选草稿：设置页当前表单值，密钥留空/'***' 由后端回退已存值。 */
export interface StalwartTestDraft {
  baseUrl?: string
  apiKey?: string
  domain?: string
}

/** 通知发信（SMTP）候选草稿：同上。 */
export interface SmtpTestDraft {
  host?: string
  /** 端口草稿是输入框原始字符串，后端按正整数解析。 */
  port?: string
  username?: string
  password?: string
  from?: string
}

/** 测试邮箱管理（Stalwart 开户）候选草稿：只用于本次探测，绝不落库。 */
export function testStalwartConnection(draft: StalwartTestDraft): Promise<MailTestResult> {
  return request<MailTestResult>('/api/admin/mail-stalwart/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  }, { messagePolicy: statusOnlyMessage })
}

/** 测试通知发信（SMTP）候选草稿：同上。 */
export function testSmtpConnection(draft: SmtpTestDraft): Promise<MailTestResult> {
  return request<MailTestResult>('/api/admin/mail-smtp/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  }, { messagePolicy: statusOnlyMessage })
}

export function resendMemberActivation(id: string): Promise<unknown> {
  return request(`/api/admin/members/${encodeURIComponent(id)}/resend-activation`, { method: 'POST' }, { messagePolicy: statusOnlyMessage })
}
