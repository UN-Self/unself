// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 会话客户端（#11）：登录态查询、登出、登录跳转。
 * 后端契约：core-api #5（GET /api/me、POST /api/auth/logout、GET /api/auth/login）。
 */

/** 当前用户（/api/me 200）。role 供前端视图判断（管理入口显隐），真值以服务端守卫为准。 */
export interface SessionUser {
  id: string
  name: string
  issuer: string
  sub: string
  role?: string
}

export type MeResult =
  | { authenticated: true; user: SessionUser }
  | { authenticated: false }

/** 查询会话态；网络错误视为未登录（由调用方决定提示）。 */
export async function fetchMe(): Promise<MeResult> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' })
    if (!res.ok) {
      return { authenticated: false }
    }
    const body = (await res.json()) as { authenticated: boolean; user?: SessionUser }
    if (body.authenticated && body.user) {
      return { authenticated: true, user: body.user }
    }
    return { authenticated: false }
  } catch {
    return { authenticated: false }
  }
}

/** 登出：清会话 Cookie（后端同时清 HttpOnly），前端回到登录页由调用方处理。 */
export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
  } catch {
    // 网络失败也继续：本地会话态按已登出处理
  }
}

/**
 * 登录整页跳转地址：next 为登录成功后的站内回跳（仅本站绝对路径）。
 * 直访登录页时 next 为空，后端回 /，由工作台落地规则决定第一个启用模块。
 */
export function loginUrl(next?: string): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) {
    return '/api/auth/login'
  }
  return `/api/auth/login?next=${encodeURIComponent(next)}`
}
