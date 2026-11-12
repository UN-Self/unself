// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 注册表客户端（#12 边栏数据源）：
 * GET /api/modules → 成员视角 enabled 模块（core-api #7）。
 * 传输/错误构造统一走 lib/api-client（#142）：本文件只留端点函数与域类型。
 */

import { request, type ApiError } from './api-client'

export type { ApiError }

/**
 * 注册表条目（core-api RegistryEntry 的成员侧子集，#348 遗留收窄 / #349）。
 * GET /api/modules 回 id/enabled/name/manifest + **entry**（#349 U9：清单不再承载地址后，
 * 这是壳 iframe 装载的唯一地址源，值 = 注册表 entry 列）；mode/storage_level/credential_hash
 * 继续不回（落点形态/存储选择管理员视角才有，凭证敏感面在 GET /api/admin/modules）。
 */
export interface RegistryModule {
  id: string
  enabled: boolean
  /** 可读名（manifest.description ?? id，服务端填）。 */
  name: string
  /** 装载地址（#349 U9 唯一落点字段）：注册表 entry 列原值；未写 → null（不渲染装载入口）。 */
  entry: string | null
  manifest: {
    id: string
    route: string
    runtimes: string[]
    permissions?: string[]
    version: string
    description?: string
    icon?: string
  } | null
}

export async function fetchEnabledModules(): Promise<RegistryModule[]> {
  return request<RegistryModule[]>('/api/modules', undefined, { messagePolicy: () => '模块列表加载失败' })
}

/**
 * 外壳 frame-src 白名单（决策 #63/#73 动态 CSP）：
 * GET /api/modules/frame-origins → 启用模块 entry 的 origin 集合（不含实例自身 origin）。
 * 壳启动时拉一次注入到 index.html 的 CSP；加模块只改注册表，不重建外壳。
 */
export async function fetchFrameOrigins(): Promise<string[]> {
  return request<string[]>('/api/modules/frame-origins', undefined, {
    messagePolicy: () => 'frame 白名单加载失败',
  })
}

/**
 * 条目 entry（注册表 entry 列，#349 U9）→ iframe 装载地址。
 * 同域完整 URL → 相对路径（单域名路径制 §5.3）；独立域名 → 绝对 URL（第三方逃生口）。
 * baseURL 仅测试注入用；运行时以当前页面 origin 为基准。
 */
export function moduleFrameSrc(mod: RegistryModule, baseURL?: string): string | null {
  const entry = mod.entry
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
