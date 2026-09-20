// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 站内通知共享状态（#19）：铃铛在桌面左栏与窄屏顶栏各渲染一份，
 * 但通知数据只有一份——模块级单例，先挂载者拉取、另一处共享结果，避免重复请求。
 * 克制口径：进工作台拉一次（ensureLoaded）+ 打开下拉刷新（refresh）；
 * 无轮询、无实时推送、无批量已读、无通知偏好。
 * 通知是附属 UI：加载失败只回报错文案，不抛不崩、不影响工作台。
 */
import { ref, type Ref } from 'vue'

import {
  fetchNotifications,
  fetchUnreadCount,
  markNotificationRead,
  type NotificationItem,
} from './notification-api'

export interface NotificationsState {
  items: Ref<NotificationItem[]>
  unreadCount: Ref<number>
  error: Ref<string | null>
  /** 进工作台拉一次（已加载不再拉；并发调用防重入）。 */
  ensureLoaded(): Promise<void>
  /** 打开下拉时刷新（列表 + 未读数）。 */
  refresh(): Promise<void>
  /** 点击即读：调后端 + 本地置 isRead + 未读减一。 */
  markRead(id: string): Promise<void>
}

/** 两个挂载点共享的模块级单例。 */
let shared: NotificationsState | null = null

export function useNotifications(): NotificationsState {
  if (!shared) {
    shared = createState()
  }
  return shared
}

function createState(): NotificationsState {
  const items = ref<NotificationItem[]>([])
  const unreadCount = ref(0)
  const error = ref<string | null>(null)

  /** 已成功加载过（失败不算，留给打开面板时重试）。 */
  let loaded = false
  /** 在途防重入（两个铃铛同帧挂载时只发一轮请求）。 */
  let loading = false

  async function load(): Promise<void> {
    try {
      const [list, count] = await Promise.all([fetchNotifications(), fetchUnreadCount()])
      items.value = list
      unreadCount.value = count
      error.value = null
      loaded = true
    } catch {
      error.value = '通知加载失败'
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded || loading) return
    loading = true
    try {
      await load()
    } finally {
      loading = false
    }
  }

  async function refresh(): Promise<void> {
    await load()
  }

  async function markRead(id: string): Promise<void> {
    const item = items.value.find((entry) => entry.id === id)
    if (!item || item.isRead) return
    try {
      await markNotificationRead(id)
    } catch {
      // 后端失败静默：不打断 UI，也不假装已读
      return
    }
    item.isRead = true
    unreadCount.value = Math.max(0, unreadCount.value - 1)
  }

  return { items, unreadCount, error, ensureLoaded, refresh, markRead }
}
