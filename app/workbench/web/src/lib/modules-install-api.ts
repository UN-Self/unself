// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 「新增模块」双模式客户端（#349 决策 #108/#109）。
 *
 * - 模式二（反连）：浏览器 WebCrypto 生成 key（**壳永远拿不到明文**——只有哈希过网，
 *   决策 #108），core 记账 pending；用户把 env 两行贴到模块侧自部署；模块 dial-home
 *   上线后「测试连接」查在线，保存 = 用既有注册端点激活（enabled=true）。
 * - 模式一（CF 部署）：把 npm 规格 + 会话内 CF token 交给 core 运行时装配
 *   （token 用后即焚，决策 #165；前端不留存、不写入任何本地存储）。
 */

import { makeApiError, request, statusOnlyMessage } from './api-client'
import type { AdminModule } from './admin-api'
import { ADD_MODULE_PATHS } from './modules-install-paths'

// 路径单点零依赖单放（worker 测试安全 import，见 modules-install-paths.ts 头注）；
// 这里 re-export 保住既有导入面。
export { ADD_MODULE_PATHS }

/** 生成 32 字节随机 key（base64url）与其 SHA-256 hex——两者都只在浏览器内存里。 */
export async function generateConnectKey(): Promise<{ key: string; keyHash: string }> {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const key = base64Url(bytes)
  const hash = await sha256Hex(key)
  return { key, keyHash: hash }
}

/** text → hex(SHA-256)（小写 64 位；与 core 侧 CREDENTIAL_HASH_PATTERN 同一形状）。 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 反连记账（pending）：core 存哈希并分配 /m/<id>/ 路由，此时尚未启用。 */
export function registerConnectModule(input: {
  moduleId: string
  keyHash: string
  storageLevel?: AdminModule['storage_level']
}): Promise<{ id: string; mode: string; enabled: boolean }> {
  return request(ADD_MODULE_PATHS.register, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }, { messagePolicy: statusOnlyMessage })
}

/** 隧道在线状态（「测试连接」的数据源；在线 ≠ 已启用）。 */
export function fetchConnectStatus(moduleId: string): Promise<{ moduleId: string; online: boolean; reason?: string }> {
  return request(
    `${ADD_MODULE_PATHS.status}?moduleId=${encodeURIComponent(moduleId)}`,
    undefined,
    { messagePolicy: statusOnlyMessage },
  )
}

/**
 * 保存＝激活：复用既有注册端点（同一条 upsert 写入口），只翻 enabled。
 * 落点三列/凭证哈希一律不写——合并语义（#348 review 定案）保留记账段的值。
 */
export async function activateConnectModule(moduleId: string): Promise<AdminModule> {
  const modules = await fetchAdminModulesSafe()
  const row = modules.find((m) => m.id === moduleId)
  if (!row) throw makeApiError(404, '记账行不存在，请重新生成接入码')
  return request<AdminModule>(ADD_MODULE_PATHS.activate, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: row.id,
      enabled: true,
      // manifest 快照沿用记账段的占位（真快照归后续 D4 发现流程）
      manifest: (row as AdminModule & { manifest?: unknown }).manifest ?? undefined,
    }),
  }, { messagePolicy: statusOnlyMessage })
}

async function fetchAdminModulesSafe(): Promise<Array<AdminModule & { manifest?: unknown }>> {
  return request('/api/admin/modules', undefined, { messagePolicy: statusOnlyMessage })
}

/** 模式一：core 运行时拉 npm 包并部署（CF token 只在本次请求体里，前端不落任何存储）。 */
export function installCloudflareModule(input: {
  npmSpec: string
  cfToken: string
  accountId: string
  storageLevel?: AdminModule['storage_level']
}): Promise<AdminModule> {
  return request<AdminModule>(ADD_MODULE_PATHS.install, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }, { messagePolicy: statusOnlyMessage })
}
