// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 注册表客户端（#12 边栏数据源）：
 * GET /api/modules → 成员视角 enabled 模块（core-api #7）。
 * 传输/错误构造统一走 lib/api-client（#142）：本文件只留端点函数与域类型。
 */

import { request, type ApiError } from './api-client'

export type { ApiError }

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

export async function fetchEnabledModules(): Promise<RegistryModule[]> {
  return request<RegistryModule[]>('/api/modules', undefined, { messagePolicy: () => '模块列表加载失败' })
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
