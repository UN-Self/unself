// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { shallowRef, computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import MessageBubble from './MessageBubble.vue'
import MessageRail from './MessageRail.vue'
import { USkeleton } from '@unself/ui'
import { formatDayLabel } from '../lib/message-time'
import { nearTop } from '../lib/scroll'
import { useMessageScroll } from '../lib/use-message-scroll'
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
  roomKey?: string
  /** 当前登录者 id（mine 判定）。 */
  currentUserId: number
  /** 更早历史加载中（滚轮上翻触发）。 */
  loadingEarlier: boolean
  /** 更早没有更多历史。 */
  noEarlier: boolean
  /** 当前会话是否私聊（#220/#339③：DM 回执 = 已读单勾）。 */
  isDm?: boolean
  /** 可达收件人数（#220 分母：房间成员−发件人；未知传 0，分母面不显示）。 */
  audienceSize?: number
  /** 回执摘要唯一真值（store.state.readReceipts；缺省 = 旧格式无回执面）。 */
  readReceipts?: Record<number, ReadReceiptsSummary>
  canManage?: boolean
  /** #339② 刚发送成功的消息 id 集：命中且 mine 的气泡播入场动效（吞入→残影→亮起），父层在 animationend 后移除。 */
  justSentIds?: number[]
}

const props = withDefaults(defineProps<MessageListProps>(), {
  roomKey: '',
  isDm: false,
  audienceSize: 0,
  readReceipts: () => ({}),
  canManage: false,
  onVisible: undefined,
  justSentIds: () => [],
})

const emit = defineEmits<{
  /** 滚轮贴近顶部 → 请求加载更早历史（一屏一触发）。 */
  'load-earlier': []
  /** 点击 mine 气泡回执标签 → 父层打开已读名单浮层（#220）。 */
  'show-receipts': [message: Message]
  /** 他人消息进入视口 → 请求父层批量上报已读（#220，参数 = 本轮新可见的消息 id）。 */
  'visible-read': [messageIds: number[]]
  /** #339② 入场动效播完 → 父层清除 justSentIds（避免重渲染重播）。 */
  'enter-done': [messageId: number]
  delete: [message: Message]
}>()

/** #339②：首渲染时已存在的消息是历史（不播入场）；其后新出现的他人消息才播（左缘滑入）。 */
const baselineMaxId = shallowRef(0)
onMounted(() => {
  baselineMaxId.value = Math.max(0, ...props.messages.map((m) => m.id))
})
function isFreshArrival(message: Message): boolean {
  return message.sender.id !== props.currentUserId && message.id > baselineMaxId.value
}
// #339② 兑底：reduced-motion 下 animation 被全局禁用，animationend 永不 fire → enter-done
// 不回抛 → justSentIds 泄漏。slowing 800ms（> duration-slow 400ms）仍未见清除则按 animationend 已到
// 处理（父层照常清除）。正常路径 animationend 先到，watch 清理定时器无副作用。
let enterFallbackTimer: ReturnType<typeof setTimeout> | null = null
watch(() => props.justSentIds, (now, prev) => {
  if (prev && now.length > 0 && now.length === prev.length && now.every((id, i) => id === prev[i])) return
  if (enterFallbackTimer) clearTimeout(enterFallbackTimer)
  if (now.length > 0) {
    enterFallbackTimer = setTimeout(() => {
      for (const id of props.justSentIds) emit('enter-done', id)
    }, 800)
  }
}, { deep: true })
onBeforeUnmount(() => { if (enterFallbackTimer) clearTimeout(enterFallbackTimer) })

const scroller = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const { following, overflowing, activeId, updatePosition, select, latest } = useMessageScroll(
  scroller, content, () => props.roomKey, () => props.messages.map((message) => message.id),
)

/** 滚动锁：加载触发后到新批次到达前不再重复触发。 */
let loadArmed = true

function onScroll(): void {
  const el = scroller.value
  if (el === null) return
  updatePosition()
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
  <div class="stream-shell">
    <div
      ref="scroller"
      class="stream"
      data-test="message-stream"
      :class="{ 'stream-sweep': props.justSentIds.length > 0 }"
      aria-label="消息流"
      @scroll.passive="onScroll"
    >
      <div ref="content" class="stream-content">
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
              :data-message-id="message.id"
              :ref="(el) => observeBubbleEl(el, message.id, message.sender.id)"
              :message="message"
              :mine="message.sender.id === currentUserId"
              :is-dm="isDm"
              :audience-size="audienceSize"
              :read-summary="readReceipts?.[message.id] ?? null"
              :can-delete="message.sender.id === currentUserId || canManage"
              :entering="props.justSentIds.includes(message.id)"
              :receiving="isFreshArrival(message)"
              @enter-done="emit('enter-done', message.id)"
              @show-receipts="onShowReceipts"
              @delete="emit('delete', $event)"
            />
          </template>
        </template>
      </div>
    </div>
    <MessageRail v-if="overflowing && messages.length" :messages="messages" :active-id="activeId" :following="following" @select="select" @latest="latest()" />
  </div>
</template>

<style scoped>
.stream-shell { position: relative; flex: 1; min-height: 0; }
.stream {
  flex: 1;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  overflow-anchor: none;
  display: flex;
  flex-direction: column;
  background: var(--unself-color-surface);
  scrollbar-width: thin;
}
.stream-content {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  gap: var(--unself-space-2);
  width: min(100%, 800px);
  min-height: 100%;
  box-sizing: border-box;
  margin: 0 auto;
  padding: var(--unself-space-5) calc(var(--unself-space-8) + var(--unself-space-4)) var(--unself-space-5) var(--unself-space-4);
}
.stream-content > :first-child { margin-top: auto; }
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

/* #339② 中段残影（定案「弧线回归」）：justSentIds 非空期间，消息流右缘一道淡影自下而上掠过
   （起点=composer 方向，终点=流顶方向；钟形透明峰 0.30（与气泡残影同峰））。
   位移/时长/缓动全 tokens；透明度峰为定案值。reduced-motion 全局降级。 */
.stream-sweep::after {
  content: '';
  position: absolute;
  right: var(--unself-space-2);
  bottom: 0;
  width: 56px;
  height: 38%;
  border-radius: var(--unself-radius-lg, 12px);
  background: var(--unself-color-primary);
  opacity: 0;
  pointer-events: none;
  filter: blur(6px);
  animation: stream-sweep var(--unself-duration-slow) var(--unself-ease-out);
}
@keyframes stream-sweep {
  0% { transform: translateY(30%) scale(0.7); opacity: 0; }
  35% { opacity: 0.3; }
  100% { transform: translateY(-120%) scale(0.5); opacity: 0; }
}
</style>
