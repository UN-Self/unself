// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 注册表客户端（#12 边栏数据源）：
 * GET /api/modules → 成员视角 enabled 模块（core-api #7）。
 */

/** 注册表条目（core-api RegistryEntry 的成员侧子集）。 */
export interface RegistryModule {
  id: string
  enabled: boolean
  version: string | null
  manifest: {
    id: string
    route: string
    entry: string
    runtime: string
    capabilities?: string[]
    version: string
    description?: string
    icon?: string
  } | null
}

/** 后端 JSON 错误（人话 + request id + 技术详情，§6.5 三层透传）。 */
export interface ApiError extends Error {
  status: number
  requestId?: string
  detail?: string
}

export async function fetchEnabledModules(): Promise<RegistryModule[]> {
  let res: Response
  try {
    res = await fetch('/api/modules', { credentials: 'same-origin' })
  } catch {
    throw makeError(0, '网络不可用，请检查连接后重试')
  }
  const requestId = res.headers.get('x-request-id') ?? undefined
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null
    throw makeError(res.status, `模块列表加载失败（${res.status}）`, requestId, body?.detail)
  }
  return (await res.json()) as RegistryModule[]
}

function makeError(status: number, message: string, requestId?: string, detail?: string): ApiError {
  const err = new Error(message) as ApiError
  err.status = status
  err.requestId = requestId
  err.detail = detail
  return err
}

/**
 * manifest.entry → iframe 装载地址。
 * 同域完整 URL → 相对路径（单域名路径制 §5.3）；独立域名 → 绝对 URL（第三方逃生口）。
 * baseURL 仅测试注入用；运行时以当前页面 origin 为基准。
 */
export function moduleFrameSrc(mod: RegistryModule, baseURL?: string): string | null {
  const entry = mod.manifest?.entry
  if (!entry) return null
  try {
    const base = baseURL ?? globalThis.location?.origin ?? 'https://unself.invalid'
    const url = new URL(entry, base)
    const currentOrigin = globalThis.location?.origin ?? base
    return url.origin === currentOrigin ? url.pathname + url.search : url.toString()
  } catch {
    return null
  }
}
