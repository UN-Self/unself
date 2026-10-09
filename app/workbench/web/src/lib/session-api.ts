// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 会话客户端（#11）：登录态查询、登出、登录跳转。
 * 后端契约：core-api #5（GET /api/me、POST /api/auth/logout、GET /api/auth/login）。
 * 传输统一走 lib/api-client（#142）：探测语义（不抛错）由 requestOk 提供。
 */

import { request, send } from './api-client'

/** 当前用户（/api/me 200）。role 供前端视图判断（管理入口显隐），真值以服务端守卫为准。 */
export interface SessionUser {
  id: string
  name: string
  issuer: string
  sub: string
  avatarUrl?: string
  role?: string
}

export type MeResult =
  | {
      authenticated: true
      user: SessionUser
      /** 邮件轴是否开启（#168）：成员可见能力，决定工作台入口与说明页落地。 */
      avatarUploadEnabled?: boolean
      mailEnabled: boolean
      /** 服务端解析好的邮件门户地址（#168）：portalUrl 优先、domain 推导兜底；缺 → null。 */
      mailPortalUrl: string | null
    }
  | { authenticated: false }

/** 查询会话态；网络错误/非 2xx/形状不符均视为未登录（由调用方决定提示）。 */
export async function fetchMe(): Promise<MeResult> {
  try {
    const body = await request<{
      authenticated: boolean
      user?: SessionUser
      avatarUploadEnabled?: boolean
      mailEnabled?: boolean
      mailPortalUrl?: string | null
    }>('/api/me')
    if (body?.authenticated && body.user) {
      return {
        authenticated: true,
        user: body.user,
        avatarUploadEnabled: body.avatarUploadEnabled === true,
        // 老后端/缺字段 → 按无邮件能力处理（入口不显示，不抛错）。
        mailEnabled: body.mailEnabled === true,
        mailPortalUrl: typeof body.mailPortalUrl === 'string' ? body.mailPortalUrl : null,
      }
    }
    return { authenticated: false }
  } catch {
    return { authenticated: false }
  }
}

/** 登出：清会话 Cookie（后端同时清 HttpOnly），前端回到登录页由调用方处理。 */
export async function logout(): Promise<void> {
  try {
    await send('/api/auth/logout', { method: 'POST' })
  } catch {
    // 网络失败/非 2xx 也继续：本地会话态按已登出处理
  }
}

/** 当前成员在 Core 修改昵称；Chat 无独立资料写入口。 */
export async function updateMyName(name: string): Promise<string> {
  const result = await request<{ name: string }>('/api/me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return result.name
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

/** 资料写入走 Core；文件请求体不经过 JSON 编码。 */
export async function uploadMyAvatar(file: File): Promise<string> {
  const result = await request<{ avatarUrl: string }>('/api/me/avatar', {
    method: 'PUT', headers: { 'content-type': file.type }, body: file,
  })
  return result.avatarUrl
}
export async function removeMyAvatar(): Promise<string> {
  return (await request<{ avatarUrl: string }>('/api/me/avatar', { method: 'DELETE' })).avatarUrl
}
