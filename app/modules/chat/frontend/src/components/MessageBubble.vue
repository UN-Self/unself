// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { computed, provide, ref, useId } from 'vue'
import { Check, ArrowUp, AtSign } from 'lucide-vue-next'
import { UContextMenu, UHoverCard, UMessage, UMessageAvatar, UMessageBubble, UProfileCard, type MenuAction } from '@unself/ui'

import { attachmentResourceKey, useAttachmentResource } from '../lib/attachment-resource'
import MessageContent from './MessageContent.vue'
import MessageActions from './MessageActions.vue'
import ForwardBundleView from './ForwardBundleView.vue'
import { deletionLabel } from '../lib/message-deletion'
import type { ChannelMember, Message, ReadReceiptsSummary } from '../lib/types'

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
  /** 被回复消息的发言人名（引用块第一行灰字；replyDeleted 时不显示）。 */
  replyAuthor?: string
  /** 回复原消息已删除。 */
  replyDeleted?: boolean
  /** 被引用原文已加载在当前消息流里（true 时引用块显示「回到原文」按钮）。 */
  replyJumpable?: boolean
  /** 点击跳转后短暂高亮该气泡（flash 由父层定时清除）。 */
  flash?: boolean
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
  /** 发送者在当前会话的成员信息（群聊来自成员名单，私聊来自 otherUser；资料卡的 role/joinedAt/邮箱来源，缺失降级）。 */
  member?: ChannelMember
}

const props = withDefaults(defineProps<MessageBubbleProps>(), {
  replyPreview: undefined,
  replyAuthor: undefined,
  replyDeleted: undefined,
  replyJumpable: false,
  flash: false,
  highlighted: undefined,
  isDm: false,
  audienceSize: undefined,
  readSummary: null,
  canDelete: false,
  entering: false,
  receiving: false,
  member: undefined,
})

const HHMM_RE = /(\d{2}:\d{2})/

/** 资料卡内容节点 id：触发器用 aria-describedby 指向它，键盘/读屏用户聚焦头像时能读到卡面。 */
const cardId = useId()

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
  /** 右键菜单选「引用」：上抛原消息，父层开 composer 回复条。 */
  quote: [message: Message]
  /** #347 右键头像选「@ 提及」：上抛被 @ 者的消息，父层往 composer 插入 @username。 */
  mention: [message: Message]
  /** #347 右键菜单选「转发」：上抛原消息，父层开转发目标弹窗（单条逐条）。 */
  forward: [message: Message]
  /** #347 右键菜单选「多选」：上抛原消息，父层（MessageList）进入多选模式。 */
  'multi-select': [message: Message]
  /** 点击引用块「回到原文」：上抛引用方消息（replyTo.id 是滚动目标），父层滚动定位。 */
  'jump-to-reply': [message: Message]
}>()

/** #339② 入场动效结束（以落点亮起段为准）：只在 entering 期间监听，避免平时误报。 */
function onBubbleAnimEnd(event: AnimationEvent): void {
  if (props.entering && event.animationName === 'bubble-arrive') emit('enter-done')
}

/** 回执面是否显示：仅 mine 气泡 + 有回执数据（旧格式/缺省不显示）。 */
const showReceiptTag = computed(() => !props.message.deleted && props.mine && props.readSummary !== null && props.readSummary !== undefined)

/** #347 头像右键菜单：@ 提及（DM 服务端丢弃提及，不出该项；撤回消息不弹）。 */
const avatarMenuItems = computed<MenuAction[]>(() => {
  if (props.message.deleted || props.isDm) return []
  return [{ id: 'mention', label: '@ 提及', icon: AtSign }]
})

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

// ---------- #347 合并转发：摘要卡 + 内容浮层 ----------

/** forward_bundle 载荷（服务端内部 block；存在即渲染摘要卡替代正文）。 */
const bundle = computed(() => {
  const found = props.message.blocks?.find((block) => block.type === 'forward_bundle')
  return found && found.type === 'forward_bundle' ? found : null
})
const bundleOpen = ref(false)
</script>

<template>
  <p v-if="message.deleted" class="message-system" data-test="message-system">{{ deletionLabel(message) }}</p>
  <UMessage
    v-else
    :mine="mine"
    class="bubble-row"
    :class="{ 'bubble-row-mine': mine, 'bubble-row-highlight': highlighted, 'bubble-row-flash': flash, 'bubble-entering': entering, 'bubble-row-theirs-enter': receiving && !mine }"
    :data-test="mine ? 'bubble-mine' : 'bubble-theirs'"
    @animationend="onBubbleAnimEnd"
  >
    <!-- 头像悬停/tap 开资料卡：他人与本人一致（本人卡来自消息 sender，同 memberMap 查身份）。
         触发器是真 button：头像本身是 img/aria-hidden span，不可聚焦，键盘与读屏用户走不到卡片 -->
    <!-- #347 头像右键 @ 提及：UContextMenu 包住触发按钮；DM 无菜单项（items 为空 + disabled 双保险）。
         壳 span 是必须的：UContextMenu 模板根是片段（Root+Portal，无单一 DOM 根），把 UHoverCard
         直接塞进 HoverCardTrigger(as-child) 的 slot 会让 Vue 丢弃属性透传——悬浮/点击/聚焦开卡
         全部失效。两个基元都需要真实元素当直接触发子节点，用壳隔开：右键挂壳、悬停/点击仍挂按钮。 -->
    <UContextMenu :items="avatarMenuItems" :disabled="avatarMenuItems.length === 0" @select="emit('mention', message)">
          <span class="bubble-avatar-shell">
            <UHoverCard>
              <template #trigger>
                <button
                  type="button"
                  class="bubble-avatar-card"
                  :aria-label="`查看 ${message.sender.displayName} 的资料`"
                  :aria-describedby="cardId"
                >
                  <UMessageAvatar :src="message.sender.avatarUrl" :name="message.sender.displayName" />
                </button>
              </template>
              <UProfileCard
                :id="cardId"
                :display-name="message.sender.displayName"
                :login-name="message.sender.loginName"
                :avatar-url="message.sender.avatarUrl"
                :email="member?.email"
                :role="member?.role === 'owner' ? 'owner' : 'member'"
                :joined-at="member?.joinedAt"
              />
            </UHoverCard>
          </span>
        </UContextMenu>

    <div class="bubble-main">
      <div class="bubble-meta">
        <span class="bubble-author">{{ message.sender.displayName }}</span>
        <time v-if="timeLabel" class="bubble-time">{{ timeLabel }}</time>
        <span v-else-if="fallbackTime" class="bubble-time">{{ fallbackTime }}</span>
      </div>

      <!-- 引用块在气泡体内（UMessageBubble 插槽第一段），见下方 MessageActions 处 -->

      <MessageActions :message="message" :can-delete="canDelete" @delete="emit('delete', message)" @quote="emit('quote', message)" @preview="attachmentView?.preview()" @forward="emit('forward', message)" @multi-select="emit('multi-select', message)">
        <UMessageBubble class="bubble-body" :variant="mine ? 'solid' : 'soft'">
          <!-- 引用卡片：整个模块（竖线+底色+作者行+引文）可点回原文。可跳转时是 role=button（Enter/空格触发）；
               右上角箭头是纯装饰（aria-hidden + pointer-events:none），键盘入口就是这张卡本身 -->
          <div
            v-if="!message.deleted && (replyPreview || replyDeleted)"
            class="bubble-reply"
            :class="{ 'bubble-reply-jumpable': replyJumpable && !replyDeleted, 'bubble-reply-mine': mine }"
            data-test="bubble-reply"
            :role="replyJumpable && !replyDeleted ? 'button' : undefined"
            :tabindex="replyJumpable && !replyDeleted ? 0 : undefined"
            @click.stop="replyJumpable && !replyDeleted && emit('jump-to-reply', message)"
            @keydown.enter.prevent="replyJumpable && !replyDeleted && emit('jump-to-reply', message)"
            @keydown.space.prevent="replyJumpable && !replyDeleted && emit('jump-to-reply', message)"
          >
            <span v-if="replyAuthor" class="bubble-reply-author">{{ replyAuthor }}</span>
            <span class="bubble-reply-text">{{ replyDeleted ? '原消息已删除' : replyPreview }}</span>
            <!-- 纯装饰图标：跳转交互在整块引用卡上（点它或 Enter/空格均可） -->
            <span
              v-if="replyJumpable && !replyDeleted"
              class="bubble-reply-jump"
              data-test="reply-jump"
              aria-hidden="true"
            >
              <ArrowUp :size="14" />
            </span>
          </div>
          <!-- #347 合并转发摘要卡：点击开浮层看完整列表（样式与引用卡同族：左竖条 + tinted 底） -->
          <button
            v-if="bundle"
            type="button"
            class="bubble-forward-card"
            data-test="forward-bundle-card"
            @click.stop="bundleOpen = true"
          >
            <span class="bubble-forward-text">[聊天记录] {{ bundle.count }} 条消息</span>
          </button>
          <MessageContent v-else ref="attachmentView" :message="message" />
        </UMessageBubble>
      </MessageActions>

      <!-- #347 合并转发内容浮层（本组件局部开关；Teleport 到 body） -->
      <ForwardBundleView :open="bundleOpen" :messages="bundle?.messages ?? []" @close="bundleOpen = false" />

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
/* 头像资料卡触发器：复位 button 外观（头像本身是 img），撑住 32px 不收缩 */
/* #347 右键菜单触发壳（真实 DOM，UContextMenu 的处理器落在这里）；不参与布局语义，内联排布即可 */
.bubble-avatar-shell { display:inline-flex; flex:none; }
.bubble-avatar-card { display:flex; flex:none; align-items:center; padding:0; border:0; border-radius:var(--unself-radius-full); background:transparent; cursor:pointer; }
.bubble-avatar-card:focus-visible { outline:var(--unself-focus-ring); outline-offset:2px; }
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
.bubble-reply-author {
  display: block;
  font-size: var(--unself-font-size-xs);
  margin-bottom: 1px;
}
/* 引用卡片：气泡体内色块（作者行 + 引文全文），左竖线无底色，右上角留跳转按钮位；可点态 hover 才加深底色 */
.bubble-reply {
  position: relative;
  margin-bottom: var(--unself-space-1);
  padding: var(--unself-space-1) calc(var(--unself-space-4) + 22px) var(--unself-space-1) var(--unself-space-2);
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
  background: transparent;
  border-left: 2px solid var(--unself-color-border);
  border-radius: 0 var(--unself-radius-sm) var(--unself-radius-sm) 0;
}
/* 引用卡片可点态：整个模块（含左竖线、底色、作者行、引文）点击回原文，悬浮高亮——对方灰、我方主题色，与气泡归属一致 */
.bubble-reply-jumpable { cursor: pointer; transition: background-color var(--unself-duration-fast) var(--unself-ease-out); }
.bubble-reply-jumpable:hover { background: color-mix(in srgb, var(--unself-color-text) 8%, transparent); }
.bubble-reply-jumpable:focus-visible { outline: var(--unself-focus-ring); outline-offset: 2px; }
.bubble-reply-mine { border-left-color: var(--unself-color-primary); }
.bubble-reply-jumpable.bubble-reply-mine:hover { background: color-mix(in srgb, var(--unself-color-primary) 16%, transparent); }
.bubble-reply-text {
  /* 全文引用超长时截到 6 行，避免引用块撑爆气泡（line-clamp 与 pre-wrap 可共存） */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
  overflow: hidden;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bubble-reply-jump {
  position: absolute;
  top: 2px;
  right: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: var(--unself-color-text-tertiary);
  pointer-events: none;
}
/* 跳转定位后的短暂高亮（父层 1.2s 后清 flash）；reduced-motion 全局禁 animation，无动效即无闪烁 */
.bubble-row-flash .bubble-main { animation: bubble-jump-flash 1.2s var(--unself-ease-out); }
/* reduced-motion 下全局禁 animation，上面动画不播就没了任何反馈：静态 outline 兜底（1.2s 后父层清 flash 一并消失） */
@media (prefers-reduced-motion: reduce) {
  .bubble-row-flash .bubble-main { animation: none; outline: 2px solid var(--unself-color-primary); }
}
@keyframes bubble-jump-flash {
  0%, 40% { outline: 2px solid var(--unself-color-primary); }
  100% { outline: 2px solid transparent; }
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

/* #347 合并转发摘要卡：与引用卡同族（左竖条 + tinted 底），整卡可点开浮层 */
.bubble-forward-card {
  display: block;
  width: 100%;
  margin-bottom: var(--unself-space-1);
  padding: var(--unself-space-1) var(--unself-space-2);
  border: 0;
  border-left: 2px solid var(--unself-color-primary);
  border-radius: 0 var(--unself-radius-sm) var(--unself-radius-sm) 0;
  background: transparent;
  color: var(--unself-color-text-secondary);
  font: inherit;
  font-size: var(--unself-font-size-sm);
  text-align: left;
  cursor: pointer;
}
.bubble-forward-card:hover { background: color-mix(in srgb, var(--unself-color-text) 8%, transparent); }
.bubble-forward-card:focus-visible { outline: var(--unself-focus-ring); outline-offset: 2px; }
.bubble-forward-text { display: block; white-space: pre-wrap; overflow-wrap: anywhere; }

/* #339② 入场动效（发送）：气泡本体微缩淡入→归位（吞入+亮起两段，backwards 消首帧闪）。
   原第三段紫色残影（bubble-ghost 伪元素）已按部署者要求整体移除。
   时长/缓动/位移/缩放全部契约 tokens；reduced-motion 由 styles.css 全局 animation 降级兑底。 */
.bubble-row.bubble-entering {
  /* backwards：挂类首帧前就应用 from 态（opacity 0），消除动画应用时序差的首帧闪 */
  animation: bubble-arrive var(--unself-duration-slow) var(--unself-ease-out) backwards;
}
@keyframes bubble-arrive {
  from { opacity: 0; transform: translateY(var(--unself-motion-lift-y)) scale(var(--unself-motion-press-scale)); }
  60% { opacity: 1; }
  to { opacity: 1; transform: none; }
}
/* 紫色残影段（bubble-ghost 伪元素）已按部署者要求整体移除：主题色闪层观感干扰大于动效增益。 */
</style>
