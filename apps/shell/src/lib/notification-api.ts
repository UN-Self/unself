// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 站内通知客户端（#19 通知域，后端契约见 core-api）：
 * - GET  /api/notifications              → 当前用户倒序最近 100 条
 *     （typeLabel = 服务端 notification_types.template 中文名，payload 已解析为对象）
 * - GET  /api/notifications/unread-count → { count: number }
 * - POST /api/notifications/:id/read     → { ok: true }
 *
 * 前端只做展示与点击置读，不硬编码类型中文名、不做批量已读/轮询/实时推送。
 */

/** 通知条目（core-api #19 响应子集）。 */
export interface NotificationItem {
  id: string
  type: string
  typeLabel: string
  payload: unknown
  isRead: boolean
  createdAt: string
}

export async function fetchNotifications(): Promise<NotificationItem[]> {
  const res = await fetch('/api/notifications', { credentials: 'same-origin' })
  if (!res.ok) {
    throw new Error(`请求失败（${res.status}）`)
  }
  return (await res.json()) as NotificationItem[]
}

export async function fetchUnreadCount(): Promise<number> {
  const res = await fetch('/api/notifications/unread-count', { credentials: 'same-origin' })
  if (!res.ok) {
    throw new Error(`请求失败（${res.status}）`)
  }
  const body = (await res.json()) as { count: number }
  return body.count
}

export async function markNotificationRead(id: string): Promise<void> {
  const res = await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, {
    method: 'POST',
    credentials: 'same-origin',
  })
  if (!res.ok) {
    throw new Error(`请求失败（${res.status}）`)
  }
}
