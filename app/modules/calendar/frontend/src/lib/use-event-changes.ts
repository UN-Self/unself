// SPDX-License-Identifier: AGPL-3.0-only
import { onMounted, onUnmounted, ref } from 'vue'
import type { EventChange } from '../../../src/types'
import { AuthExpiredError, fetchChanges } from './api'

const POLL_INTERVAL = 3000

/** 其它日程的变更计数：先累计给界面提示，做列表时再改成按需拉取。 */
const pendingCount = ref(0)

/** 每 3 秒拉变更流，游标推进、按 eventId 去重；切后台暂停切回补拉，自己产生的变更按版本过滤。 */
export function useEventChanges(options: {
  eventId: string
  getVersion: () => number
  onHit: (change: EventChange) => void
  onAuthExpired: () => void
}) {
  const cursor = ref(0)
  const latestByEvent = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | undefined

  async function poll(): Promise<void> {
    try {
      const { changes, cursor: next } = await fetchChanges(cursor.value)
      cursor.value = next
      for (const change of changes) {
        // 去重：同一 event 只提示版本最大的那条
        const seen = latestByEvent.get(change.eventId) ?? 0
        if (change.toVersion <= seen) continue
        latestByEvent.set(change.eventId, change.toVersion)
        // 其它日程的变更只计数，做列表时改为直接消费
        if (change.eventId !== options.eventId) {
          pendingCount.value += 1
          continue
        }
        // 自己保存产生的变更，版本号不比本地新，不提示（等价于 excludeEventId 的目的）
        if (change.toVersion <= options.getVersion()) continue
        options.onHit(change)
      }
    } catch (err) {
      // 401 交给界面提示，其余错误（网络抖动、5xx）忽略，下一轮再试
      if (err instanceof AuthExpiredError) options.onAuthExpired()
    }
  }

  function start(): void {
    if (timer !== undefined) return
    timer = setInterval(() => void poll(), POLL_INTERVAL)
  }

  function stop(): void {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  function onVisibility(): void {
    if (document.hidden) stop()
    else {
      void poll()
      start()
    }
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility)
    if (!document.hidden) start()
  })

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onVisibility)
    stop()
  })

  return { poll, pendingCount }
}
