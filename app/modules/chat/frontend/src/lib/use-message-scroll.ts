// SPDX-License-Identifier: AGPL-3.0-only
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { nearBottom, scrollToBottom, scrollToPosition } from './scroll'

/** 消息流本地滚动状态；不持有会话数据，不触发网络请求。 */
export function useMessageScroll(
  viewport: Ref<HTMLElement | null>,
  content: Ref<HTMLElement | null>,
  roomKey: () => string,
  messageIds: () => number[],
) {
  const following = ref(true)
  const overflowing = ref(false)
  const activeId = ref<number | null>(null)
  let resizeObserver: ResizeObserver | undefined
  let disposed = false

  function motion(): ScrollBehavior {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  }

  function updatePosition(): void {
    const el = viewport.value
    if (!el) return
    overflowing.value = el.scrollHeight > el.clientHeight
    following.value = nearBottom(el)
    if (following.value) {
      activeId.value = messageIds().at(-1) ?? null
      return
    }
    const center = el.getBoundingClientRect().top + el.clientHeight / 2
    let distance = Infinity
    for (const target of el.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const rect = target.getBoundingClientRect()
      const next = Math.abs(rect.top + rect.height / 2 - center)
      if (next < distance) {
        distance = next
        activeId.value = Number(target.dataset.messageId)
      }
    }
  }

  function latest(behavior: ScrollBehavior = motion()): void {
    if (!viewport.value) return
    following.value = true
    activeId.value = messageIds().at(-1) ?? null
    overflowing.value = viewport.value.scrollHeight > viewport.value.clientHeight
    scrollToBottom(viewport.value, behavior)
  }

  function select(id: number): void {
    const el = viewport.value
    if (!el) return
    const target = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find((item) => Number(item.dataset.messageId) === id)
    if (!target) return
    following.value = false
    activeId.value = id
    const rect = target.getBoundingClientRect()
    const top = el.scrollTop + rect.top - el.getBoundingClientRect().top
      - (el.clientHeight - rect.height) / 2
    scrollToPosition(el, Math.max(0, top), motion())
  }

  // pre flush 捕获旧布局，nextTick 后才读取新高度；浏览器原生 anchoring 在容器上关闭。
  watch(() => [roomKey(), messageIds()] as const, async ([room, ids], [previousRoom, previousIds]) => {
    const el = viewport.value
    if (!el) return
    const changedRoom = room !== previousRoom
    const firstPage = previousIds.length === 0 && ids.length > 0
    const prepended = !changedRoom && previousIds.length > 0 && ids[0] !== previousIds[0]
      && ids.includes(previousIds[0]!)
    const previousTop = el.scrollTop
    const previousHeight = el.scrollHeight
    const wasAtBottom = nearBottom(el)
    await nextTick()
    if (disposed || viewport.value !== el || roomKey() !== room) return
    if (changedRoom || firstPage) latest('auto')
    else if (prepended) {
      scrollToPosition(el, previousTop + el.scrollHeight - previousHeight)
      updatePosition()
    } else if (ids.at(-1) !== previousIds.at(-1) && wasAtBottom) latest(motion())
  })

  onMounted(async () => {
    await nextTick()
    if (disposed) return
    latest('auto')
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        if (following.value) latest('auto')
        else if (viewport.value) overflowing.value = viewport.value.scrollHeight > viewport.value.clientHeight
      })
      if (content.value) resizeObserver.observe(content.value)
      if (viewport.value) resizeObserver.observe(viewport.value)
    }
  })

  onBeforeUnmount(() => {
    disposed = true
    resizeObserver?.disconnect()
  })

  return { following, overflowing, activeId, updatePosition, select, latest }
}
