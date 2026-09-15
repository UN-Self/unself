// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { computed } from 'vue'
import { Paperclip } from 'lucide-vue-next'

import VoiceBubble from './VoiceBubble.vue'
import type { Message } from '../lib/types'

/**
 * 单条消息气泡（#218 消息流）：头像/作者/时间/正文/附件。
 * 正文为纯文本渲染（markdown 富文本由 T4 的 composer/markdown 环节统一处理，此处不做 HTML 注入）。
 * 非文本附件（文件）渲染「不可预览」占位 + 原始文件名；语音附件转发 VoiceBubble。
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
}

const props = defineProps<MessageBubbleProps>()

const HHMM_RE = /(\d{2}:\d{2})/

/** 气泡右上时间 HH:mm（日期语义由分隔条承担，气泡只留时刻）。 */
const timeLabel = computed(() => {
  const date = new Date(props.message.createdAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toTimeString().slice(0, 5)
})

const invalidTime = computed(() => timeLabel.value === '')

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
</style>
