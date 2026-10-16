// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { computed, provide, ref } from 'vue'
import { Check } from 'lucide-vue-next'
import { UMessage, UMessageAvatar, UMessageBubble } from '@unself/ui'

import { attachmentResourceKey, useAttachmentResource } from '../lib/attachment-resource'
import MessageContent from './MessageContent.vue'
import MessageActions from './MessageActions.vue'
import { deletionLabel } from '../lib/message-deletion'
import type { Message, ReadReceiptsSummary } from '../lib/types'

/**
 * 单条消息气泡（#218 消息流）：头像/作者/时间/正文/附件。
 * 正文为纯文本渲染（markdown 富文本由 T4 的 composer/markdown 环节统一处理，此处不做 HTML 注入）。
 * 媒体附件由 MessageAttachment 渲染；操作由 MessageActions 统一管理。
 * #220/#339③ 已读回执：mine 气泡下缘回执标签（DM=已读单勾；群聊=已读 n/m），点击发 show-receipts
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
  canDelete?: boolean
  /** #339②：命中 justSentIds 时播入场动效（吞入→残影→亮起三段 CSS），animationend 后上抛 enter-done。 */
  entering?: boolean
  /** #339②：他人新到达消息（左缘滑入一次性入场）；历史/本人消息不挂。 */
  receiving?: boolean
}

const props = withDefaults(defineProps<MessageBubbleProps>(), {
  replyPreview: undefined,
  replyDeleted: undefined,
  highlighted: undefined,
  isDm: false,
  audienceSize: undefined,
  readSummary: null,
  canDelete: false,
  entering: false,
  receiving: false,
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
  /** #339② 入场动效播完（bubble-arrive animationend），通知父层清 justSentIds。 */
  'enter-done': []
  delete: [message: Message]
}>()

/** #339② 入场动效结束（以落点亮起段为准）：只在 entering 期间监听，避免平时误报。 */
function onBubbleAnimEnd(event: AnimationEvent): void {
  if (props.entering && event.animationName === 'bubble-arrive') emit('enter-done')
}

/** 回执面是否显示：仅 mine 气泡 + 有回执数据（旧格式/缺省不显示）。 */
const showReceiptTag = computed(() => !props.message.deleted && props.mine && props.readSummary !== null && props.readSummary !== undefined)

/** DM：读1人即全读 → 单勾「已读」（#339③，TG 口径双勾另有语义）；未读 → 「未读」（无发送中态）。 */
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

provide(attachmentResourceKey, useAttachmentResource(() => props.message.deleted ? null : props.message.attachment))
const attachmentView = ref<InstanceType<typeof MessageContent> | null>(null)
</script>

<template>
  <p v-if="message.deleted" class="message-system" data-test="message-system">{{ deletionLabel(message) }}</p>
  <UMessage
    v-else
    :mine="mine"
    class="bubble-row"
    :class="{ 'bubble-row-mine': mine, 'bubble-row-highlight': highlighted, 'bubble-entering': entering, 'bubble-row-theirs-enter': receiving && !mine }"
    :data-test="mine ? 'bubble-mine' : 'bubble-theirs'"
    @animationend="onBubbleAnimEnd"
  >
    <UMessageAvatar :src="message.sender.avatarUrl" :name="message.sender.displayName" />

    <div class="bubble-main">
      <div class="bubble-meta">
        <span class="bubble-author">{{ message.sender.displayName }}</span>
        <time v-if="timeLabel" class="bubble-time">{{ timeLabel }}</time>
        <span v-else-if="fallbackTime" class="bubble-time">{{ fallbackTime }}</span>
      </div>

      <!-- 引用块：被回复消息摘要 / 已删除提示 -->
      <div v-if="!message.deleted && (replyPreview || replyDeleted)" class="bubble-reply">
        <span class="bubble-reply-text">{{ replyDeleted ? '原消息已删除' : replyPreview }}</span>
      </div>

      <MessageActions :message="message" :can-delete="canDelete" @delete="emit('delete', message)" @preview="attachmentView?.preview()">
        <UMessageBubble class="bubble-body" :variant="mine ? 'solid' : 'soft'">
          <MessageContent ref="attachmentView" :message="message" />
        </UMessageBubble>
      </MessageActions>

      <!-- #220/#339③ 已读回执标签（mine 尾部；DM=已读单勾（TG 口径：双勾另有所指），群聊=已读 n/m）；点击开名单浮层（父层渲染） -->
      <button
        v-if="showReceiptTag"
        type="button"
        class="bubble-receipt"
        data-test="bubble-receipt"
        :aria-label="receiptAria"
        @click="emit('show-receipts', message)"
      >
        <template v-if="isDm">
          <template v-if="dmRead">
            <Check class="bubble-receipt-check" :size="12" aria-hidden="true" />
            <span class="bubble-receipt-text" data-test="receipt-dm">已读</span>
          </template>
          <template v-else>
            <span class="bubble-receipt-text" data-test="receipt-dm">未读</span>
          </template>
        </template>
        <template v-else>
          <span class="bubble-receipt-text" data-test="receipt-group">{{ groupReceiptLabel }}</span>
        </template>
      </button>
    </div>
  </UMessage>
</template>

<style scoped>
.message-system { margin: var(--unself-space-3) 0; padding: var(--unself-space-1) var(--unself-space-3); text-align: center; color: var(--unself-color-text-tertiary); font-size: var(--unself-font-size-xs); overflow-wrap: anywhere; }
.bubble-row { max-width:100%; padding:var(--unself-space-1) 0; }
.bubble-row-highlight .bubble-main {
  outline: 1px solid var(--unself-color-primary-soft);
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
  max-width:100%;
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
.bubble-receipt-text {
  font-variant-numeric: tabular-nums;
}
/* #339③ DM 单勾与文字的对齐：图标色随标签文字（tertiary），垂直居中已由父 flex 兑底 */
.bubble-receipt-check {
  color: var(--unself-color-text-tertiary);
  flex-shrink: 0;
}
.bubble-body:focus-visible { outline:var(--unself-focus-ring); outline-offset:2px; }

/* #339② 入场动效（发送）：三段一气呵成 ——
   ① 吞入：气泡本体微缩淡入
   ② 残影：伪元素淡影贴右缘掠过（透明度峰 0.30 为定案值；opacity 非时长不属令牌纪律管辖）
   ③ 亮起：本体归位（收尾于同一 keyframes）
   时长/缓动/位移/缩放全部契约 tokens；reduced-motion 由 styles.css 全局 animation 降级兑底。 */
.bubble-row.bubble-entering {
  animation: bubble-arrive var(--unself-duration-slow) var(--unself-ease-out);
}
@keyframes bubble-arrive {
  from { opacity: 0; transform: translateY(var(--unself-motion-lift-y)) scale(var(--unself-motion-press-scale)); }
  60% { opacity: 1; }
  to { opacity: 1; transform: none; }
}
.bubble-row.bubble-entering .bubble-body {
  position: relative;
}
.bubble-row.bubble-entering .bubble-body::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  /* 静态态必须 opacity:0：动画结束后伪元素回到静态值，非 0 会永久盖住气泡（真机实锤）。
     动画期间由 keyframes 拉到 0.3 峰值，结束自然回落 0。 */
  opacity: 0;
  background: var(--unself-color-primary);
  animation: bubble-ghost var(--unself-duration-slow) var(--unself-ease-out);
}
@keyframes bubble-ghost {
  0% { opacity: 0; transform: translate(var(--unself-space-6), var(--unself-motion-lift-y)) scale(var(--unself-motion-press-scale)); }
  35% { opacity: 0.3; }
  100% { opacity: 0; transform: none; }
}
</style>
