// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import MessageBubble from './MessageBubble.vue'
import { USkeleton } from '@unself/ui'
import { formatDayLabel } from '../lib/message-time'
import { nearBottom, nearTop, scrollToBottom } from '../lib/scroll'
import type { Message } from '../lib/types'

/**
 * 消息流（#218）：倒序仓库（旧→新升序渲染）+ 日期分隔 + 上翻加载更早历史 +
 * 新消息贴底自动滚动 + 离底浮标。
 * 数据流（T5 接线约定）：props 进（messages/状态），emits 出（load-earlier）。
 */
export interface MessageListProps {
  messages: Message[]
  /** 当前登录者 id（mine 判定）。 */
  currentUserId: number
  /** 更早历史加载中（滚轮上翻触发）。 */
  loadingEarlier: boolean
  /** 更早没有更多历史。 */
  noEarlier: boolean
}

const props = defineProps<MessageListProps>()

const emit = defineEmits<{
  /** 滚轮贴近顶部 → 请求加载更早历史（一屏一触发）。 */
  'load-earlier': []
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
      <MessageBubble
        v-for="message in section.messages"
        :key="message.id"
        :message="message"
        :mine="message.sender.id === currentUserId"
      />
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
