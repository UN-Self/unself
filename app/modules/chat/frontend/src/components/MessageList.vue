// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import MessageBubble from './MessageBubble.vue'
import { USkeleton } from '@unself/ui'
import { formatDayLabel } from '../lib/message-time'
import { nearBottom, nearTop, scrollToBottom } from '../lib/scroll'
import type { Message, ReadReceiptsSummary } from '../lib/types'

/**
 * 消息流（#218）：倒序仓库（旧→新升序渲染）+ 日期分隔 + 上翻加载更早历史 +
 * 新消息贴底自动滚动 + 离底浮标。
 * 数据流（T5 接线约定）：props 进（messages/状态），emits 出（load-earlier）。
 * #220：回执 props/isDm 透传给气泡；IntersectionObserver 收集进入视口的他人消息 id
 * 批量上抛（visible-read），替身边界在 store（本组件不发请求）。
 */
export interface MessageListProps {
  messages: Message[]
  /** 当前登录者 id（mine 判定）。 */
  currentUserId: number
  /** 更早历史加载中（滚轮上翻触发）。 */
  loadingEarlier: boolean
  /** 更早没有更多历史。 */
  noEarlier: boolean
  /** 当前会话是否私聊（#220：DM 回执 = 已读 ✓✓）。 */
  isDm?: boolean
  /** 可达收件人数（#220 分母：房间成员−发件人；未知传 0，分母面不显示）。 */
  audienceSize?: number
  /** 回执摘要唯一真值（store.state.readReceipts；缺省 = 旧格式无回执面）。 */
  readReceipts?: Record<number, ReadReceiptsSummary>
}

const props = withDefaults(defineProps<MessageListProps>(), {
  isDm: false,
  audienceSize: 0,
  readReceipts: () => ({}),
  onVisible: undefined,
})

const emit = defineEmits<{
  /** 滚轮贴近顶部 → 请求加载更早历史（一屏一触发）。 */
  'load-earlier': []
  /** 点击 mine 气泡回执标签 → 父层打开已读名单浮层（#220）。 */
  'show-receipts': [message: Message]
  /** 他人消息进入视口 → 请求父层批量上报已读（#220，参数 = 本轮新可见的消息 id）。 */
  'visible-read': [messageIds: number[]]
}>()

const scroller = ref<HTMLElement | null>(null)

/** 滚动锁：加载触发后到新批次到达前不再重复触发。 */
let loadArmed = true

function onScroll(): void {
  const el = scroller.value
  if (el === null) return
  if (loadArmed && nearTop(el) && !props.loadingEarlier && !props.noEarlier) {
    loadArmed = false
    emit('load-earlier')
  }
}

/** 加载完成后（messages 变化）重新武装触发器。 */
watch(
  () => props.loadingEarlier,
  (loading) => {
    if (!loading) loadArmed = true
  },
)

/** 新消息到达：原本贴底才自动跟随；离底浏览历史时不拽人。 */
watch(
  () => props.messages.length,
  async (len, prev) => {
    if (prev === undefined) return
    if (len <= prev) return
    const el = scroller.value
    if (el === null) return
    if (nearBottom(el)) {
      await nextTick()
      const after = scroller.value
      if (after !== null) scrollToBottom(after)
    }
  },
)

/** 空流占位骨架行数。 */
const skeletonLines = computed(() => 6)

/** 分组：消息数组 → [日期标签, 区段] 有序分段（同日相邻消息同段）。 */
const sections = computed(() => {
  const out: Array<{ label: string; messages: Message[] }> = []
  for (const message of props.messages) {
    const label = formatDayLabel(message.createdAt)
    const last = out.at(-1)
    if (last && last.label === label) {
      last.messages.push(message)
    } else {
      out.push({ label, messages: [message] })
    }
  }
  return out
})

/** 视口观察器（#220）：进入视口的他人消息 id 批量上抛；无 IntersectionObserver 环境静默降级。 */
let observer: IntersectionObserver | null = null
const visibleBuffer = new Map<Element, number>()
let flushScheduled = false

function flushVisible(): void {
  flushScheduled = false
  const ids: number[] = []
  for (const [el, id] of visibleBuffer) {
    ids.push(id)
    visibleBuffer.delete(el)
  }
  if (ids.length) emit('visible-read', ids)
}

function ensureObserver(): void {
  if (typeof IntersectionObserver !== 'function') return
  if (observer !== null) return
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const el = entry.target as HTMLElement
      const idAttr = el.dataset?.receiptId ?? el.getAttribute?.('data-receipt-id')
      if (idAttr) visibleBuffer.set(entry.target, Number(idAttr))
    }
    if (!flushScheduled) {
      flushScheduled = true
      setTimeout(flushVisible, 200)
    }
  })
}

function observeBubble(el: Element, id: number): void {
  ensureObserver()
  observer?.observe(el)
}

/** v-for ref 回调：只观察他人消息的根元素（mine 气泡不报已读）。 */
function observeBubbleEl(el: unknown, id: number, senderId: number): void {
  if (el === null || senderId === props.currentUserId) return
  const root = (el as { $el?: Element }).$el ?? (el as Element)
  if (root instanceof Element) {
    root.setAttribute('data-receipt-id', String(id))
    observeBubble(root, id)
  }
}

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

/** 点击气泡上的回执标签 → 上抛（浮层由父层渲染）。 */
function onShowReceipts(message: Message): void {
  emit('show-receipts', message)
}
</script>

<template>
  <div
    ref="scroller"
    class="stream"
    data-test="message-stream"
    aria-label="消息流"
    @scroll.passive="onScroll"
  >
    <!-- 顶部状态：更早历史加载中 / 没有更多 -->
    <div v-if="loadingEarlier" class="stream-state" data-test="loading-earlier">
      <USkeleton :lines="2" />
    </div>
    <div v-else-if="noEarlier && messages.length" class="stream-state" data-test="no-earlier">
      <span class="stream-hint">没有更早的消息了</span>
    </div>

    <div v-if="!messages.length" class="stream-empty" data-test="stream-empty">
      <USkeleton :lines="skeletonLines" />
    </div>

    <template v-for="section in sections" :key="section.label">
      <div class="stream-day" data-test="day-divider">{{ section.label }}</div>
      <template v-for="message in section.messages" :key="message.id">
        <MessageBubble
          :ref="(el) => observeBubbleEl(el, message.id, message.sender.id)"
          :message="message"
          :mine="message.sender.id === currentUserId"
          :is-dm="isDm"
          :audience-size="audienceSize"
          :read-summary="readReceipts?.[message.id] ?? null"
          @show-receipts="onShowReceipts"
        />
      </template>
    </template>
  </div>
</template>

<style scoped>
.stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--unself-space-3) var(--unself-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
  scrollbar-width: thin;
}
.stream-state {
  display: flex;
  justify-content: center;
  padding: var(--unself-space-2);
}
.stream-hint {
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
}
.stream-empty {
  flex: 1;
  display: flex;
  align-items: center;
  opacity: 0.6;
}
.stream-day {
  align-self: center;
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
  background: var(--unself-color-surface);
  border-radius: var(--unself-radius-full);
  padding: 2px var(--unself-space-3);
}
</style>
