// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 全站唯一请求出口（#142，评审报告 #138 ①）：
 * 六份域封装（admin-api/invite-api/builtin-auth-api/setup-api/token-api/registry-api/
 * notification-api）各自复制 fetch + JSON 解析 + ApiError，本文件收编为单中心——
 * 域文件只留端点函数（URL/方法/body 组装），传输、错误形状、凭证、人话策略归这里。
 *
 * - 传输：fetch 包装，credentials 'same-origin'（Cookie 会话是唯一凭证，§6.5）
 * - JSON：2xx 解析 JSON；204/空体回 null（requestOk/send 无解析路径）
 * - 401：交给 guarded-fetch 全局拦截跳登录（#11），client 不做任何 401 特判——
 *   错误对象照常抛出（带真实 status），语义与历史实现逐字节一致
 * - 错误：统一 ApiError（status + 人话 message + requestId + detail + 可选 code）
 *
 * 行为零变化铁律（#142）：URL、方法、请求头、body、错误文案、错误形状、
 * loading 时机全部保持历史实现原样。
 */

/** 统一错误形状（status + 人话 message + 可选 code；requestId/detail 供错误卡）。 */
export interface ApiError extends Error {
  status: number
  /** 服务端 request id（x-request-id 响应头），透传给异常卡（§6.5 三层透传）。 */
  requestId?: string
  /** 服务端技术详情（JSON body 的 detail 字段），折叠展示用。 */
  detail?: string
  /** 服务端可选稳定错误码（JSON body 的 code 字段，独立于展示文案）。 */
  code?: string
}

export function makeApiError(status: number, message: string, requestId?: string, detail?: string, code?: string): ApiError {
  const err = new Error(message) as ApiError
  err.status = status
  err.requestId = requestId
  err.detail = detail
  if (code !== undefined) err.code = code
  return err
}

/** 非流式 JSON 请求默认人话策略：message 优先取后端 error 字段（后端已给人话），拿不到回 `请求失败（<status>）`。 */
export function preferServerMessage(status: number, serverMessage?: string): string {
  const trimmed = typeof serverMessage === 'string' ? serverMessage.trim() : ''
  return trimmed || `请求失败（${status}）`
}

/** status-only 人话策略：忽略后端 error，文案由域内按状态映射后经 payload 传入。 */
export function statusOnlyMessage(status: number, _serverMessage?: string): string {
  return `请求失败（${status}）`
}

/** message 出错时的人话兜底（fetch 抛 TypeError 等非 ApiError 异常）。 */
export const NETWORK_UNAVAILABLE = '网络不可用，请检查连接后重试'

/** 传给 request 的解析/错误构造配置（与历史实现逐一对齐）。 */
export interface ClientOptions {
  /** 默认：后端 error 字段优先；域策略可结合稳定 code 判别，兼容仅按状态/文案判断的调用方。 */
  messagePolicy?: (status: number, serverMessage?: string, code?: string) => string
}

/**
 * 统一 request 出口：fetch 包装 + JSON 解析 + ApiError 单点。
 * 成功回解析后的 JSON（body 缺失时为 null）；非 2xx / 网络异常抛 ApiError。
 */
export async function request<T = unknown>(url: string, init?: RequestInit, options?: ClientOptions): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init })
  } catch {
    throw makeApiError(0, NETWORK_UNAVAILABLE)
  }
  const requestId = res.headers.get('x-request-id') ?? undefined
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string; code?: unknown } | null
    const code = typeof body?.code === 'string' ? body.code : undefined
    const policy = options?.messagePolicy ?? preferServerMessage
    throw makeApiError(res.status, policy(res.status, body?.error, code), requestId, body?.detail, code)
  }
  return ((await res.json().catch(() => null)) ?? null) as T
}

/** POST 等无响应体消费需求时用：成功不解析 body（网络层失败仍抛 ApiError）。 */
export async function send(url: string, init?: RequestInit): Promise<void> {
  let res: Response
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init })
  } catch {
    throw makeApiError(0, NETWORK_UNAVAILABLE)
  }
  const requestId = res.headers.get('x-request-id') ?? undefined
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string; code?: unknown } | null
    const code = typeof body?.code === 'string' ? body.code : undefined
    throw makeApiError(res.status, preferServerMessage(res.status, body?.error), requestId, body?.detail, code)
  }
}

/** 探测类请求：成功只看 2xx 不解析 body（/api/me 探测、路由守卫用）。 */
export async function requestOk(url: string, init?: RequestInit): Promise<boolean> {
  let res: Response
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init })
  } catch {
    return false
  }
  return res.ok
}
