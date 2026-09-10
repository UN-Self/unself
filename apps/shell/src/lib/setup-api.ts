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
 */

/** 后端 JSON 错误形状（core-api 统一 { error }）。 */
export interface ApiError extends Error {
  status: number
  /** 服务端 request id（X-Request-Id 或响应体），透传给异常卡。 */
  requestId?: string
  detail?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init })
  } catch {
    throw makeError(0, '网络不可用，请检查连接后重试')
  }
  const requestId = res.headers.get('x-request-id') ?? undefined
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null
    throw makeError(res.status, humanize(res.status, body?.error), requestId, body?.detail)
  }
  return (await res.json()) as T
}

function makeError(status: number, message: string, requestId?: string, detail?: string): ApiError {
  const err = new Error(message) as ApiError
  err.status = status
  err.requestId = requestId
  err.detail = detail
  return err
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

/** setup 状态（GET /api/setup/status）。 */
export interface SetupStatus {
  /** 实例是否已完成激活。 */
  done: boolean
  /** 未激活时：URL 上的 token 是否仍可用。 */
  tokenValid?: boolean
}

export function getSetupStatus(token?: string): Promise<SetupStatus> {
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  return request<SetupStatus>(`/api/setup/status${query}`)
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
  )
}

/**
 * POST /api/setup/activate：消费 token → 首个管理员 + 永久封死（直线流程收尾）。
 * 不再携带 body（配置由 oidc-config 先行落库）；无会话 401 由调用方经 /api/me 预判。
 */
export function activateSetup(token: string): Promise<ActivateResult> {
  return request<ActivateResult>(`/api/setup/activate?token=${encodeURIComponent(token)}`, {
    method: 'POST',
  })
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
    const res = await fetch('/api/oidc/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issuer }),
      credentials: 'same-origin',
    })
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; issuer?: string; warnings?: unknown; error?: string }
      | null
    if (!res.ok || !body?.ok) {
      return { ok: false, reason: humanizeOidcTest(res.status, body?.error) }
    }
    return {
      ok: true,
      issuer: body.issuer ?? issuer,
      warnings: Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : [],
    }
  } catch {
    return { ok: false, reason: '连接测试失败：请确认服务端可访问该 Issuer' }
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
