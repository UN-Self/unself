// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块 token 客户端（#12 iframe 装载器 → SDK 握手）：
 * 壳为已启用模块取 token（POST /api/modules/:id/token，core-api #3），
 * 经 postMessage 交给 iframe 内的 SDK（§5.2 交付通道）。
 */

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

export interface ApiError extends Error {
  status: number
  requestId?: string
  detail?: string
}

export async function fetchModuleToken(moduleId: string): Promise<IssuedToken> {
  let res: Response
  try {
    res = await fetch(`/api/modules/${encodeURIComponent(moduleId)}/token`, {
      method: 'POST',
      credentials: 'same-origin',
    })
  } catch {
    throw makeError(0, '网络不可用，请检查连接后重试')
  }
  const requestId = res.headers.get('x-request-id') ?? undefined
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null
    throw makeError(res.status, tokenErrorMessage(res.status, body?.error), requestId, body?.detail)
  }
  return (await res.json()) as IssuedToken
}

function tokenErrorMessage(status: number, _serverMessage?: string): string {
  switch (status) {
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

function makeError(status: number, message: string, requestId?: string, detail?: string): ApiError {
  const err = new Error(message) as ApiError
  err.status = status
  err.requestId = requestId
  err.detail = detail
  return err
}
