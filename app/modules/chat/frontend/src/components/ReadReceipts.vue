<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { X } from 'lucide-vue-next'

import { UButton } from '@unself/ui'
import { formatMessageTime } from '../lib/message-time'
import type { ReadReceiptsSummary } from '../lib/types'

/**
 * 已读名单浮层（#220）：Teleport 到 body 的模态卡片——已读逐行（姓名 + 时间）+
 * 未读占位；Esc / 遮罩 / 关闭钮三条关闭路径。样式只取 --unself-* tokens；
 * 动效参数走 --unself-duration-*（reduced-motion 由 styles.css 全局降级兜住）。
 */
export interface ReadReceiptsProps {
  /** 回执摘要（null = 无数据仍可开，显示空名单）。 */
  summary: ReadReceiptsSummary | null
  /** 可达收件人数（分母：房间成员−发件人）。 */
  audienceSize: number
  /** 开关。 */
  open: boolean
  /** 会话名（浮层标题「xx 的已读情况」）。 */
  roomName?: string
}

const props = withDefaults(defineProps<ReadReceiptsProps>(), {
  roomName: '',
})

const emit = defineEmits<{
  /** 任一关闭路径（Esc/遮罩/关闭钮）触发；开关状态由父层持有。 */
  close: []
}>()

const readCount = (): number => props.summary?.count ?? 0

/** 未读人数：可达收件人 − 已读（下限 0，防御脏数据）。 */
const unreadCount = (): number => Math.max(0, props.audienceSize - readCount())

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open) emit('close')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="receipt-layer" data-test="read-receipts-overlay">
      <div class="receipt-scrim" data-test="receipt-scrim" aria-hidden="true" @click="emit('close')" />
      <section
        class="receipt-card"
        role="dialog"
        aria-modal="true"
        aria-label="已读情况"
      >
        <header class="receipt-head">
          <span class="receipt-title" data-test="receipt-title">
            {{ roomName ? `${roomName} · 已读情况` : '已读情况' }}
          </span>
          <UButton variant="ghost" size="sm" data-test="receipt-close" aria-label="关闭" @click="emit('close')">
            <X :size="16" aria-hidden="true" />
          </UButton>
        </header>

        <ul class="receipt-list" data-test="receipt-list">
          <li
            v-for="entry in summary?.readBy ?? []"
            :key="entry.userId"
            class="receipt-row"
            data-test="receipt-row-read"
          >
            <span class="receipt-name">{{ entry.displayName }}</span>
            <time class="receipt-time">{{ formatMessageTime(entry.readAt) }}</time>
          </li>
          <li v-if="unreadCount() > 0" class="receipt-row receipt-row-unread" data-test="receipt-row-unread">
            <span class="receipt-name">未读 {{ unreadCount() }} 人</span>
          </li>
        </ul>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.receipt-layer {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-4);
}
.receipt-scrim {
  position: absolute;
  inset: 0;
  background: var(--unself-color-scrim);
}
.receipt-card {
  position: relative;
  width: min(360px, 100%);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--unself-color-bg);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  box-shadow: var(--unself-shadow-pop);
  transition: opacity var(--unself-duration-fast) var(--unself-ease-out);
}
.receipt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-2);
  padding: var(--unself-space-3) var(--unself-space-4);
  border-bottom: 1px solid var(--unself-color-border);
}
.receipt-title {
  font-size: var(--unself-font-size-base);
  font-weight: 600;
  color: var(--unself-color-text);
}
.receipt-list {
  list-style: none;
  margin: 0;
  padding: var(--unself-space-2) 0;
  overflow-y: auto;
}
.receipt-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--unself-space-3);
  padding: var(--unself-space-2) var(--unself-space-4);
}
.receipt-name {
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text);
}
.receipt-row-unread .receipt-name {
  color: var(--unself-color-text-tertiary);
}
.receipt-time {
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
  font-variant-numeric: tabular-nums;
}
</style>
