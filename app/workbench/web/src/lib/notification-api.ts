// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 站内通知客户端（#19 通知域，后端契约见 core-api）：
 * - GET  /api/notifications              → 当前用户倒序最近 100 条
 *     （typeLabel = 服务端 notification_types.template 中文名，payload 已解析为对象）
 * - GET  /api/notifications/unread-count → { count: number }
 * - POST /api/notifications/:id/read     → { ok: true }
 *
 * 前端只做展示与点击置读，不硬编码类型中文名、不做批量已读/轮询/实时推送。
 * 传输/错误构造统一走 lib/api-client（#142）：本文件只留端点函数与域类型。
 */

import { request, send, statusOnlyMessage } from './api-client'

/** 通知条目（core-api #19 响应子集）。 */
export interface NotificationItem {
  id: string
  type: string
  typeLabel: string
  payload: unknown
  isRead: boolean
  createdAt: string
}

/** 通知域错误文案保持原状：`请求失败（<status>）`（#142 行为零变化，statusOnly 策略）。 */
export async function fetchNotifications(): Promise<NotificationItem[]> {
  return request<NotificationItem[]>('/api/notifications', undefined, { messagePolicy: statusOnlyMessage })
}

export async function fetchUnreadCount(): Promise<number> {
  const body = await request<{ count: number }>('/api/notifications/unread-count', undefined, {
    messagePolicy: statusOnlyMessage,
  })
  return body.count
}

export async function markNotificationRead(id: string): Promise<void> {
  await send(`/api/notifications/${encodeURIComponent(id)}/read`, {
    method: 'POST',
  })
}
