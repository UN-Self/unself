// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { computed } from 'vue'
import { Paperclip } from 'lucide-vue-next'

import VoiceBubble from './VoiceBubble.vue'
import type { Message, ReadReceiptsSummary } from '../lib/types'

/**
 * 单条消息气泡（#218 消息流）：头像/作者/时间/正文/附件。
 * 正文为纯文本渲染（markdown 富文本由 T4 的 composer/markdown 环节统一处理，此处不做 HTML 注入）。
 * 非文本附件（文件）渲染「不可预览」占位 + 原始文件名；语音附件转发 VoiceBubble。
 * #220 已读回执：mine 气泡下缘回执标签（DM=已读✓✓；群聊=已读 n/m），点击发 show-receipts
 * 由父层开名单浮层（本组件不渲染浮层）。
 */
export interface MessageBubbleProps {
  message: Message
  /** 是否当前登录者发的（右侧对齐 + 主色底）。 */
  mine: boolean
  /** 被回复消息的摘要文本（已有 replyTo 时显示，deleted 时显示已撤回）。 */
  replyPreview?: string
  /** 回复原消息已删除。 */
  replyDeleted?: boolean
  /** 高亮（提及我/回复我）。 */
  highlighted?: boolean
  /** 私聊会话（#220）：DM 且已读 → 「已读」标签（aria=对方已读）。 */
  isDm?: boolean
  /** 可达收件人数（#220 分母：房间成员−发件人，发件人恒已读）。 */
  audienceSize?: number
  /** 已读回执摘要（#220；缺省不显示回执面——旧格式历史消息兼容）。 */
  readSummary?: ReadReceiptsSummary | null
}

const props = withDefaults(defineProps<MessageBubbleProps>(), {
  replyPreview: undefined,
  replyDeleted: undefined,
  highlighted: undefined,
  isDm: false,
  audienceSize: undefined,
  readSummary: null,
})

const HHMM_RE = /(\d{2}:\d{2})/

/** 气泡右上时间 HH:mm（日期语义由分隔条承担，气泡只留时刻）。 */
const timeLabel = computed(() => {
  const date = new Date(props.message.createdAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toTimeString().slice(0, 5)
})

const invalidTime = computed(() => timeLabel.value === '')

const emit = defineEmits<{ /** 点击回执标签：请求父层打开已读名单浮层（#220）。 */
  'show-receipts': [message: Message]
}>()

/** 回执面是否显示：仅 mine 气泡 + 有回执数据（旧格式/缺省不显示）。 */
const showReceiptTag = computed(() => props.mine && props.readSummary !== null && props.readSummary !== undefined)

/** DM：读1人即全读 → ✓✓「已读」；未读 → 「未读」（简化口径，无发送中态）。 */
const dmRead = computed(() => (props.readSummary?.count ?? 0) > 0)

/** 群聊标签文案：全部已读 → 「已读」；部分 → 「已读 n/m」；0 → 「未读」。 */
const groupReceiptLabel = computed(() => {
  const count = props.readSummary?.count ?? 0
  const total = props.audienceSize ?? 0
  if (total > 0 && count >= total) return '已读'
  if (count > 0) return `已读 ${count}/${total}`
  return '未读'
})

/** 标签 aria 文案（屏幕阅读器语义，不参与视觉断言）。 */
const receiptAria = computed(() =>
  props.isDm ? (dmRead.value ? '对方已读' : '对方未读') : '已读名单',
)

/** 时间兜底：非 ISO 串里的 HH:mm 直接抠出来（mock 数据容错）。 */
const fallbackTime = computed(() => {
  if (!invalidTime.value) return ''
  return HHMM_RE.exec(props.message.createdAt)?.[1] ?? ''
})

/** 文件类附件（无 url 可播/无 kind 标记）显示名 + 大小占位。 */
const fileAttachment = computed(() => {
  const a = props.message.attachment
  if (!a || a.kind === 'voice' || a.kind === 'audio') return null
  return a
})
</script>

<template>
  <div
    class="bubble-row"
    :class="{ 'bubble-row-mine': mine, 'bubble-row-highlight': highlighted }"
    :data-test="mine ? 'bubble-mine' : 'bubble-theirs'"
  >
    <img v-if="message.sender.avatarUrl" class="bubble-avatar" :src="message.sender.avatarUrl" alt="" />
    <div v-else class="bubble-avatar bubble-avatar-fallback" aria-hidden="true">
      {{ message.sender.displayName.slice(0, 1) }}
    </div>

    <div class="bubble-main">
      <div class="bubble-meta">
        <span class="bubble-author">{{ message.sender.displayName }}</span>
        <time v-if="timeLabel" class="bubble-time">{{ timeLabel }}</time>
        <span v-else-if="fallbackTime" class="bubble-time">{{ fallbackTime }}</span>
      </div>

      <!-- 引用块：被回复消息摘要 / 已删除提示 -->
      <div v-if="replyPreview || replyDeleted" class="bubble-reply">
        <span class="bubble-reply-text">{{ replyDeleted ? '原消息已删除' : replyPreview }}</span>
      </div>

      <div class="bubble-body">
        <p class="bubble-text">{{ message.content }}</p>

        <VoiceBubble v-if="message.attachment && (message.attachment.kind === 'voice' || message.attachment.kind === 'audio')" :attachment="message.attachment" />

        <div v-else-if="fileAttachment" class="bubble-file" data-test="bubble-file">
          <Paperclip :size="14" aria-hidden="true" />
          <span class="bubble-file-name">{{ fileAttachment.name }}</span>
          <span class="bubble-file-meta">{{ Math.max(1, Math.round((fileAttachment.size || 0) / 1024)) }} KB</span>
        </div>
      </div>

      <!-- #220 已读回执标签（mine 尾部；DM=已读 ✓✓，群聊=已读 n/m）；点击开名单浮层（父层渲染） -->
      <button
        v-if="showReceiptTag"
        type="button"
        class="bubble-receipt"
        data-test="bubble-receipt"
        :aria-label="receiptAria"
        @click="emit('show-receipts', message)"
      >
        <template v-if="isDm">
          <span class="bubble-receipt-text" data-test="receipt-dm">{{ dmRead ? '已读 ✓✓' : '未读' }}</span>
        </template>
        <template v-else>
          <span class="bubble-receipt-text" data-test="receipt-group">{{ groupReceiptLabel }}</span>
        </template>
      </button>
    </div>
  </div>
</template>

<style scoped>
.bubble-row {
  display: flex;
  align-items: flex-start;
  gap: var(--unself-space-2);
  max-width: 100%;
  padding: var(--unself-space-1) 0;
}
.bubble-row-mine {
  flex-direction: row-reverse;
}
.bubble-row-highlight .bubble-main {
  outline: 1px solid var(--unself-color-primary-soft);
}
.bubble-avatar {
  width: 32px;
  height: 32px;
  border-radius: var(--unself-radius-full);
  flex-shrink: 0;
  object-fit: cover;
}
.bubble-avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--unself-color-primary-soft);
  color: var(--unself-color-primary);
  font-size: var(--unself-font-size-sm);
  font-weight: 600;
}
.bubble-main {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
  min-width: 0;
  max-width: min(78%, 560px);
}
.bubble-meta {
  display: flex;
  align-items: baseline;
  gap: var(--unself-space-2);
  min-width: 0;
}
.bubble-row-mine .bubble-meta {
  flex-direction: row-reverse;
}
.bubble-author {
  font-size: var(--unself-font-size-sm);
  font-weight: 500;
  color: var(--unself-color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bubble-time {
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.bubble-reply {
  border-left: 2px solid var(--unself-color-border);
  padding: 2px var(--unself-space-2);
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-tertiary);
  background: var(--unself-color-surface);
  border-radius: 0 var(--unself-radius-sm) var(--unself-radius-sm) 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bubble-body {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
  padding: var(--unself-space-2) var(--unself-space-3);
  border-radius: var(--unself-radius-lg);
  background: var(--unself-color-surface);
  align-self: flex-start;
}
.bubble-row-mine .bubble-body {
  background: var(--unself-color-primary);
  color: var(--unself-color-bg);
  align-self: flex-end;
}
.bubble-row-highlight .bubble-body {
  background: var(--unself-color-primary-soft);
  color: var(--unself-color-text);
}
.bubble-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--unself-font-size-base);
  line-height: 1.5;
}
.bubble-file {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  font-size: var(--unself-font-size-sm);
}
.bubble-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bubble-file-meta {
  flex-shrink: 0;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

/* #220 已读回执标签：mine 气泡下缘；幽灵按钮（无底色），动效参数全取 tokens */
.bubble-receipt {
  align-self: flex-end;
  display: inline-flex;
  align-items: center;
  gap: var(--unself-space-1);
  padding: 2px var(--unself-space-2);
  border: none;
  border-radius: var(--unself-radius-full);
  background: transparent;
  color: var(--unself-color-text-tertiary);
  font-size: var(--unself-font-size-xs);
  cursor: pointer;
  transition: background-color var(--unself-duration-fast) var(--unself-ease-out);
}
.bubble-receipt:hover {
  background: var(--unself-color-surface-hover);
}
.bubble-receipt:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}
.bubble-receipt-text {
  font-variant-numeric: tabular-nums;
}
</style>
