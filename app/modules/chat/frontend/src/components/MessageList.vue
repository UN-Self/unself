// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { shallowRef, computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import MessageBubble from './MessageBubble.vue'
import MessageRail from './MessageRail.vue'
import { USkeleton } from '@unself/ui'
import { formatDayLabel } from '../lib/message-time'
import { nearTop, scrollToPosition } from '../lib/scroll'
import { replyAuthorOf, replyFullTextOf } from '../lib/reply-preview'
import { useMessageScroll } from '../lib/use-message-scroll'
import { forwardSuccessTickKey } from '../lib/forward-events'
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
  /** 消息头像资料卡的群内身份（senderId → ChannelMember；拉取失败为空表，卡片降级）。 */
  memberMap?: Map<number, import('../lib/types').ChannelMember>
}

const props = withDefaults(defineProps<MessageListProps>(), {
  roomKey: '',
  isDm: false,
  audienceSize: 0,
  readReceipts: () => ({}),
  canManage: false,
  onVisible: undefined,
  justSentIds: () => [],
  memberMap: () => new Map(),
})

// 转发成功计数由根层 provide（跳过 ChatLayout 中间层透传）：勾选集只在成功后清空，失败保留可换目标重试
const forwardSuccessTick = inject(forwardSuccessTickKey, ref(0))

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
  /** 右键菜单选「引用」→ 父层开 composer 回复条。 */
  quote: [message: Message]
  /** #347 右键头像选「@ 提及」→ 父层往 composer 插入 @username。 */
  mention: [message: Message]
  /** #347 转发确认 → 父层开目标弹窗（右键单条= single；多选操作条= 用户所选模式）。 */
  forward: [payload: { mode: 'single' | 'merged'; messageIds: number[] }]
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

// ---------- 引用跳转：滚到原文 + 短暂高亮 ----------

/** 已加载消息 id 集：原文在流内才显示「回到原文」按钮（不在则点了也没处滚）。 */
const loadedIds = computed(() => new Set(props.messages.map((message) => message.id)))

function canJumpTo(message: Message): boolean {
  const reply = message.replyTo
  return !!reply && !reply.deleted && loadedIds.value.has(reply.id)
}

const jumpFlashId = ref<number | null>(null)
let jumpFlashTimer: ReturnType<typeof setTimeout> | null = null

function jumpMotion(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

/** 滚到原文（视口居中）并闪高亮 1.2s；原文未加载时按钮不显示，此处只做兜底。 */
function onJumpToReply(message: Message): void {
  const targetId = message.replyTo?.id
  const view = scroller.value
  if (targetId === undefined || view === null) return
  const el = content.value?.querySelector<HTMLElement>(`[data-message-id="${targetId}"]`)
  if (!el) return
  const top = view.scrollTop + el.getBoundingClientRect().top - view.getBoundingClientRect().top
    - Math.round(view.clientHeight / 2) + Math.round(el.clientHeight / 2)
  scrollToPosition(view, Math.max(0, top), jumpMotion())
  jumpFlashId.value = targetId
  if (jumpFlashTimer) clearTimeout(jumpFlashTimer)
  jumpFlashTimer = setTimeout(() => { jumpFlashId.value = null }, 1300)
}

onBeforeUnmount(() => { if (jumpFlashTimer) clearTimeout(jumpFlashTimer); if (selectLimitTimer) clearTimeout(selectLimitTimer) })

// ---------- #347 多选转发：勾选消息 + 底部操作条（勾 1 条也可选逐条/合并） ----------

const selecting = ref(false)
const selectedIds = ref<Set<number>>(new Set())

// 多选上限与服务端 MAX_FORWARD_MESSAGES（worker/src/forward-submission.js）对齐：超限就地拦截，
// 不等提交才报错。达到上限时点选无效果并短暂显示操作条提示（视觉提醒，2.4s 自动消退）。
const MAX_FORWARD_SELECT = 50
const selectLimitHint = ref(false)
let selectLimitTimer: ReturnType<typeof setTimeout> | undefined
function flashSelectLimitHint(): void {
  selectLimitHint.value = true
  if (selectLimitTimer) clearTimeout(selectLimitTimer)
  selectLimitTimer = setTimeout(() => { selectLimitHint.value = false }, 2400)
}

function enterSelecting(first: Message): void {
  if (first.deleted) return
  selecting.value = true
  selectedIds.value = new Set([first.id])
}
function exitSelecting(): void {
  selecting.value = false
  selectedIds.value = new Set()
  selectLimitHint.value = false
  if (selectLimitTimer) clearTimeout(selectLimitTimer)
}
function toggleSelected(message: Message): void {
  // 已撤回消息不可选（守卫兜底：模板已隐藏勾选框，气泡点击路径仍会进到这里）
  if (message.deleted) return
  const next = new Set(selectedIds.value)
  if (next.has(message.id)) {
    next.delete(message.id)
    selectLimitHint.value = false
  } else {
    if (next.size >= MAX_FORWARD_SELECT) {
      flashSelectLimitHint()
      return
    }
    next.add(message.id)
  }
  selectedIds.value = next
  if (next.size === 0) exitSelecting()
}
/** 右键「转发」（单条直达）：模式固定逐条。 */
function onForwardOne(message: Message): void {
  emit('forward', { mode: 'single', messageIds: [message.id] })
}
/** 底部操作条按钮：勾选集按所选模式整批上抛。失败时保留勾选（弹窗报错后可换目标重试），
 * 成功由根层 forwardSuccessTick +1 通知清空。 */
function forwardSelected(mode: 'single' | 'merged'): void {
  const messageIds = [...selectedIds.value]
  if (!messageIds.length) return
  emit('forward', { mode, messageIds })
}
// 转发整体成功 → 清空勾选并退出多选；失败 tick 不变，多选态原样保留
watch(forwardSuccessTick, () => {
  if (selecting.value) exitSelecting()
})
// 切房退出多选：勾选集属于上一条消息流，留着会把旧房间消息 id 发到新房
watch(() => props.roomKey, () => exitSelecting())
// 勾选后消息被撤回（WS 帧原地置 deleted）：从勾选集清洗掉，否则提交整批被服务端拒绝，
// 且该行高亮还在、勾选框已消失，视觉不一致。全空时顺势退出多选态
watch(() => props.messages.map((message) => (message.deleted ? message.id : 0)), () => {
  if (!selecting.value) return
  // 勾选数有上限（几十条），先建 Map 再查，避免列表更新时 O(勾选数 × 消息数) 的 find 扫描
  const byId = new Map(props.messages.map((message) => [message.id, message]))
  const next = new Set([...selectedIds.value].filter((id) => byId.get(id)?.deleted === false))
  if (next.size === selectedIds.value.size) return
  selectedIds.value = next
  if (next.size === 0) exitSelecting()
})
/** #347 多选（M2）：点气泡内部的可交互元素（按钮/引用卡/附件预览）只执行原功能，不切换勾选。 */
function onStreamItemClick(event: MouseEvent, message: Message): void {
  if (!selecting.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest('button, a, [role="button"], input, textarea')) return
  toggleSelected(message)
}
</script>

<template>
  <div class="stream-shell">
    <div
      ref="scroller"
      class="stream"
      data-test="message-stream"
      :class="{ 'stream-sweep': props.justSentIds.length > 0, 'stream-selecting': selecting }"
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
            <div
              class="stream-item"
              :class="{ 'stream-item-selecting': selecting, 'stream-item-selected': selecting && selectedIds.has(message.id) }"
              @click="onStreamItemClick($event, message)"
            >
              <!-- #347 多选态勾选框：真实 button（Enter/空格可切换），点击不进气泡交互 -->
              <button
                v-if="selecting && !message.deleted"
                type="button"
                class="stream-select-box"
                data-test="select-box"
                :aria-pressed="selectedIds.has(message.id)"
                :aria-label="`选择消息 ${message.id}`"
                @click.stop="toggleSelected(message)"
              >{{ selectedIds.has(message.id) ? '✓' : '' }}</button>
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
                :member="memberMap.get(message.sender.id)"
                :reply-preview="replyFullTextOf(message.replyTo)"
                :reply-author="replyAuthorOf(message.replyTo)"
                :reply-deleted="message.replyTo?.deleted === true ? true : undefined"
                :reply-jumpable="canJumpTo(message)"
                :flash="jumpFlashId === message.id"
                @jump-to-reply="onJumpToReply"
                @enter-done="emit('enter-done', message.id)"
                @show-receipts="onShowReceipts"
                @delete="emit('delete', $event)"
                @quote="emit('quote', $event)"
                @mention="emit('mention', $event)"
                @forward="onForwardOne"
                @multi-select="enterSelecting"
              />
            </div>
          </template>
        </template>
      </div>
    </div>
    <MessageRail v-if="overflowing && messages.length" :messages="messages" :active-id="activeId" :following="following" @select="select" @latest="latest()" />

    <!-- #347 多选操作条：勾 1 条也出两个转发按钮（逐条=每条复制一条普通消息；合并=一条聊天记录摘要卡） -->
    <div v-if="selecting" class="stream-select-bar" data-test="select-bar">
      <span class="stream-select-count">已选 {{ selectedIds.size }} 条</span>
      <span v-if="selectLimitHint" class="stream-select-limit" data-test="select-limit" role="alert">最多可转发 {{ MAX_FORWARD_SELECT }} 条</span>
      <div class="stream-select-actions">
        <button type="button" class="stream-select-btn" data-test="forward-single" :disabled="selectedIds.size === 0" @click="forwardSelected('single')">逐条转发</button>
        <button type="button" class="stream-select-btn primary" data-test="forward-merged" :disabled="selectedIds.size === 0" @click="forwardSelected('merged')">合并转发</button>
        <button type="button" class="stream-select-cancel" @click="exitSelecting">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stream-shell { position: relative; flex: 1; min-height: 0; }

/* #347 多选：勾选框列 + 底部操作条（样式与 ChatLayout 操作条同族，tokens 全量取用）。
   非多选态 .stream-item 用 display:contents——wrapper 不参与布局，气泡行保持改动前
   「.stream-content 拉伸整行」的口径；多选态才切 flex 行（勾选框在气泡左侧）。 */
.stream-item { display: contents; }
.stream-item-selecting { display: flex; align-items: flex-end; gap: var(--unself-space-2); cursor: pointer; }
.stream-item-selected { border-radius: var(--unself-radius-md); background: color-mix(in srgb, var(--unself-color-scrim) 10%, transparent); }
/* 多选条悬浮在流底部，给滚动内容留出等高内边距，避免最后一条消息被操作条盖住：
   操作条高 = 按钮 36px + 上下 space-2，再加一档 space-2 呼吸 */
.stream-selecting { padding-bottom: calc(36px + 3 * var(--unself-space-2)); }
.stream-item-selecting > :last-child { flex: 1; min-width: 0; }
.stream-select-box {
  display: grid; place-items: center;
  width: 22px; height: 22px; flex: 0 0 22px; margin-bottom: var(--unself-space-4);
  border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-full);
  background: var(--unself-color-surface); color: var(--unself-color-primary);
  font-size: var(--unself-font-size-xs); font-weight: 700; cursor: pointer;
}
.stream-select-box[aria-pressed='true'] { border-color: var(--unself-color-primary); background: var(--unself-color-primary-soft); }
.stream-select-box:focus-visible { outline: var(--unself-focus-ring); outline-offset: 2px; }
.stream-select-bar {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
  display: flex; align-items: center; justify-content: space-between; gap: var(--unself-space-3);
  padding: var(--unself-space-2) var(--unself-space-4);
  background: var(--unself-color-bg);
  border-top: 1px solid var(--unself-color-border);
  box-shadow: var(--unself-shadow-pop);
}
.stream-select-count { color: var(--unself-color-text-secondary); font-size: var(--unself-font-size-sm); font-variant-numeric: tabular-nums; }
/* #347 多选上限提示：满 50 条继续勾选时短暂显示（role=alert 读屏可达），2.4s 自动消退 */
.stream-select-limit { color: var(--unself-color-danger); font-size: var(--unself-font-size-sm); }
.stream-select-actions { display: flex; align-items: center; gap: var(--unself-space-2); }
.stream-select-btn {
  min-height: 36px; padding: 0 var(--unself-space-3);
  border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-md);
  background: var(--unself-color-surface); color: var(--unself-color-text);
  font: inherit; font-size: var(--unself-font-size-sm); cursor: pointer;
}
.stream-select-btn.primary {
  border-color: var(--unself-color-primary); background: var(--unself-color-primary-soft); color: var(--unself-color-primary); font-weight: 600;
}
.stream-select-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.stream-select-btn:focus-visible { outline: var(--unself-focus-ring); outline-offset: 2px; }
.stream-select-cancel {
  min-height: 36px; padding: 0 var(--unself-space-2);
  border: 0; background: transparent; color: var(--unself-color-text-tertiary);
  font: inherit; font-size: var(--unself-font-size-sm); cursor: pointer;
}
.stream-select-cancel:focus-visible { outline: var(--unself-focus-ring); outline-offset: 2px; }
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
