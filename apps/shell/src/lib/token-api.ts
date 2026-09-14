// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块 token 客户端（#12 iframe 装载器 → SDK 握手）：
 * 壳为已启用模块取 token（POST /api/modules/:id/token，core-api #3），
 * 经 postMessage 交给 iframe 内的 SDK（§5.2 交付通道）。
 * 传输/错误构造统一走 lib/api-client（#142）：本文件只留端点函数与人话映射。
 */

import { request, type ApiError } from './api-client'

export type { ApiError }

export interface IssuedToken {
  token: string
  expiresIn: number
  claims: {
    iss: string
    sub: string
    aud: string
    iat: number
    exp: number
    caps?: string[]
  }
}

export async function fetchModuleToken(moduleId: string): Promise<IssuedToken> {
  return request<IssuedToken>(`/api/modules/${encodeURIComponent(moduleId)}/token`, {
    method: 'POST',
  }, { messagePolicy: tokenErrorMessage })
}

/** 服务端错误 → 人话（§6.5）：按状态固定文案，不透传后端 error。 */
function tokenErrorMessage(status: number, _serverMessage?: string): string {
  switch (status) {
    case 0:
      return '网络不可用，请检查连接后重试'
    case 401:
      return '登录已过期，请重新登录'
    case 403:
      return '此模块已停用'
    case 404:
      return '此模块不存在或已被移除'
    case 503:
      return '服务尚未就绪，请稍后重试'
    default:
      return `无法获取模块访问凭证（${status}）`
  }
}
