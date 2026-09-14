// SPDX-License-Identifier: AGPL-3.0-only

/**
 * setup 向导 API 客户端（#10）：
 * - GET /api/setup/status：实例是否已激活 / token 是否有效（路由守卫用）
 * - POST /api/setup/oidc-config：三字段配置落库（只验 token 不消费，可重复提交改填）
 * - POST /api/setup/activate：消费 token → 首个管理员 + 永久封死（无 body，配置已先落库）
 * - POST /api/oidc/test-connection：服务端代理探测 OIDC Provider（#44，避开浏览器直连 CORS）
 * - GET /api/auth/login：整页跳转 OIDC（密码永远发生在 IdP 页面，§6.5）
 *
 * 直线流程（#55）：提交配置落库 → 整页跳登录 → 回来自动提权成首个管理员 → 进工作台。
 * 后端契约见 services/core-api（#5/#55）。异常三层透传（§6.5）：
 * 成员/部署者只见人话 + request id，技术详情折叠。
 * 传输/错误构造统一走 lib/api-client（#142）：本文件只留端点函数、人话映射与域类型。
 */

import { request, type ApiError } from './api-client'

export type { ApiError }

/** testOidcConnection 的响应体子集（成功/失败共用形状）。 */
type OidcTestBody = { ok?: boolean; issuer?: string; warnings?: unknown; error?: string } | null

/** setup 状态（GET /api/setup/status）。 */
export interface SetupStatus {
  /** 实例是否已完成激活。 */
  done: boolean
  /** 未激活时：URL 上的 token 是否仍可用。 */
  tokenValid?: boolean
}

export function getSetupStatus(token?: string): Promise<SetupStatus> {
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  return request<SetupStatus>(`/api/setup/status${query}`, undefined, { messagePolicy: humanize })
}

/** 激活结果（POST /api/setup/activate）。 */
export interface ActivateResult {
  ok: boolean
  user: { id: string; name: string; role: string }
}

/** 向导录入的 OIDC 连接配置（camelCase，与后端契约一致）；scope 缺省服务端回退。 */
export interface OidcSetup {
  issuer: string
  clientId: string
  clientSecret: string
  scope?: string
}

/**
 * POST /api/setup/oidc-config：三字段（issuer/clientId/clientSecret）落库；
 * 只验 token 不消费，可重复提交改填。成功返回整页登录地址（next 已带回 token）。
 * body 严格三字段，不带 scope（契约无此字段）。
 */
export function saveOidcConfig(
  token: string,
  oidc: OidcSetup,
): Promise<{ ok: boolean; loginUrl: string }> {
  return request<{ ok: boolean; loginUrl: string }>(
    `/api/setup/oidc-config?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        issuer: oidc.issuer,
        clientId: oidc.clientId,
        clientSecret: oidc.clientSecret,
      }),
    },
    { messagePolicy: humanize },
  )
}

/**
 * POST /api/setup/activate：消费 token → 首个管理员 + 永久封死（直线流程收尾）。
 * 不再携带 body（配置由 oidc-config 先行落库）；无会话 401 由调用方经 /api/me 预判。
 */
export function activateSetup(token: string): Promise<ActivateResult> {
  return request<ActivateResult>(`/api/setup/activate?token=${encodeURIComponent(token)}`, {
    method: 'POST',
  }, { messagePolicy: humanize })
}

/** 服务端错误 → 人话（§6.5：不暴露堆栈/内部错误码）。 */
function humanize(status: number, serverMessage?: string): string {
  switch (status) {
    case 0:
      return '网络不可用，请检查连接后重试'
    case 400:
      return '链接不完整：请使用部署输出里的完整激活链接'
    case 401:
      return '需要先登录工作账号才能完成激活'
    case 403:
      return '激活链接无效或已被使用，请向部署者要新的链接'
    case 409:
      return '实例已完成配置，setup 页面已关闭'
    case 503:
      return '服务尚未就绪，请稍后重试或联系部署者'
    default:
      return serverMessage ? `配置失败（${status}）` : `配置失败（${status}），请稍后重试`
  }
}

/**
 * 测试连接（#44）：改经 core-api 服务端代理（浏览器直连 issuer 会被 CORS 拦，
 * Stalwart 实测命中），本地只保留 URL 格式预检（非 URL / 非 https 直接报错，不发请求）；
 * 失败信息按状态映射为人话（§6.5），网络异常统一提示服务端侧不可达。
 * 成功时透传服务端 warnings（#17 设置页黄牌：缺 nonce / 拿不到邮箱）。
 */
export async function testOidcConnection(
  issuer: string,
): Promise<{ ok: true; issuer: string; warnings: string[] } | { ok: false; reason: string }> {
  let issuerUrl: URL
  try {
    issuerUrl = new URL(issuer)
  } catch {
    return { ok: false, reason: 'Issuer 地址格式不正确，需要完整 URL（https://…）' }
  }
  if (issuerUrl.protocol !== 'https:') {
    return { ok: false, reason: 'Issuer 地址需要以 https:// 开头' }
  }
  try {
    const body = await request<OidcTestBody>('/api/oidc/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issuer }),
    })
    if (body?.ok) {
      return {
        ok: true,
        issuer: body.issuer ?? issuer,
        warnings: Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : [],
      }
    }
    // 2xx 但 body.ok=false：历史口径按实际状态码（200）映射人话
    return { ok: false, reason: humanizeOidcTest(200, body?.error) }
  } catch (err) {
    const apiErr = err as ApiError
    if (apiErr.status === 0) {
      return { ok: false, reason: '连接测试失败：请确认服务端可访问该 Issuer' }
    }
    // 非 2xx：message 已按默认策略收敛为 error 字段或 `请求失败（<status>）`，
    // 后者等价于历史「拿不到 error」分支
    const serverError = apiErr.message === `请求失败（${apiErr.status}）` ? undefined : apiErr.message
    return { ok: false, reason: humanizeOidcTest(apiErr.status, serverError) }
  }
}

/** 服务端代理错误 → 人话：400/502 固定文案，其余状态用 body.error 兜底。 */
function humanizeOidcTest(status: number, error?: string): string {
  switch (status) {
    case 400:
      return 'Issuer 地址需要以 https:// 开头'
    case 502:
      return '无法访问该 Issuer：请检查地址是否正确或网络可达性'
    default:
      return error || `连接测试失败（${status}），请稍后重试`
  }
}
