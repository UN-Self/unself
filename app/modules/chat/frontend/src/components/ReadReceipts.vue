<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

import { UButton, UHoverCard, UMessageAvatar, UProfileCard } from '@unself/ui'
import { formatMessageTime } from '../lib/message-time'
import type { ChannelMember, ReadReceiptsSummary } from '../lib/types'

/**
 * 已读名单浮层（#220）：Teleport 到 body 的模态卡片。名单内容为「头像 + 昵称」网格
 * （成员资料卡复用 UHoverCard+UProfileCard，同消息头像口径）；Esc / 遮罩 / 关闭钮三条关闭路径。
 * 样式只取 --unself-* tokens；动效参数走 --unself-duration-*（reduced-motion 由 styles.css 全局降级兜住）。
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
  /** 成员身份映射（senderId → ChannelMember）：头像与资料卡身份来源；
   *  空表或查不到时头像回退昵称首字符，资料卡只剩昵称行。 */
  memberMap?: Map<number, ChannelMember>
  /** 发件人 id：从未读网格剔除（发件人恒已读不计入，#229 口径）。 */
  excludeUserId?: number
}

const props = withDefaults(defineProps<ReadReceiptsProps>(), {
  roomName: '',
  memberMap: () => new Map(),
})

const emit = defineEmits<{
  /** 任一关闭路径（Esc/遮罩/关闭钮）触发；开关状态由父层持有。 */
  close: []
}>()

const readCount = (): number => props.summary?.count ?? 0

/** 未读人数：可达收件人 − 已读（下限 0，防御脏数据）。 */
const unreadCount = (): number => Math.max(0, props.audienceSize - readCount())

/** 已读条目 join 成员映射：头像与资料卡身份来自名单，缺表时头像回退首字符。 */
const readEntries = computed(() =>
  (props.summary?.readBy ?? []).map((entry) => ({ entry, member: props.memberMap.get(entry.userId) })),
)

/** 未读网格渲不渲：memberMap 完整（过滤结果数 = 未读数）且有回执数据才渲，否则退回文字占位。 */
const unreadGridReady = computed(() => props.summary != null && unreadMembers.value.length === unreadCount())

/** 未读成员：可达成员 − 已读 − 发件人；名单不完整或拉取失败时退回「未读 n 人」文字行。 */
const unreadMembers = computed(() => {
  const readIds = new Set((props.summary?.readBy ?? []).map((entry) => entry.userId))
  return [...props.memberMap.values()].filter(
    (member) => !readIds.has(member.id) && member.id !== props.excludeUserId,
  )
})

/** 打开的卡片数：Esc 先收卡片、再关浮层——reka 在 window 上处理 Esc，晚于本组件的 document 监听。 */
const openCards = ref(0)
function onCardOpenChange(open: boolean): void {
  openCards.value = Math.max(0, openCards.value + (open ? 1 : -1))
}
// 浮层关闭时卡片随之卸载，卸载不发 open-change——归零，否则下次打开 Esc 关不掉浮层
watch(
  () => props.open,
  (open) => { if (!open) openCards.value = 0 },
)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open && openCards.value === 0) emit('close')
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
          <li class="receipt-section-label">
            已读 <span class="receipt-section-count">{{ readCount() }}</span>
          </li>
          <li>
            <ul class="member-grid">
              <li
                v-for="{ entry, member } in readEntries"
                :key="entry.userId"
                class="member-cell"
                data-test="receipt-row-read"
              >
                <UHoverCard :portal="false" @open-change="onCardOpenChange">
                  <template #trigger>
                    <button
                      type="button"
                      class="member-trigger"
                      :aria-label="`查看 ${entry.displayName} 的资料`"
                      :aria-describedby="`receipt-member-card-${entry.userId}`"
                    >
                      <UMessageAvatar :src="member?.avatarUrl" :name="entry.displayName" />
                    </button>
                  </template>
                  <UProfileCard
                    :id="`receipt-member-card-${entry.userId}`"
                    :display-name="entry.displayName"
                    :login-name="member?.loginName"
                    :avatar-url="member?.avatarUrl"
                    :email="member?.email"
                    :role="member?.role === 'owner' ? 'owner' : 'member'"
                    :joined-at="member?.joinedAt"
                  />
                </UHoverCard>
                <span class="member-name" :title="entry.displayName">{{ entry.displayName }}</span>
                <time class="member-time" :datetime="entry.readAt">{{ formatMessageTime(entry.readAt) }}</time>
              </li>
            </ul>
          </li>

          <template v-if="unreadCount() > 0">
            <li class="receipt-section-label receipt-section-unread">
              未读 <span class="receipt-section-count">{{ unreadCount() }}</span>
            </li>
            <li v-if="unreadGridReady">
              <ul class="member-grid" data-test="receipt-row-unread">
                <li v-for="member in unreadMembers" :key="member.id" class="member-cell member-cell-unread">
                  <UHoverCard :portal="false" @open-change="onCardOpenChange">
                    <template #trigger>
                      <button
                        type="button"
                        class="member-trigger"
                        :aria-label="`查看 ${member.displayName} 的资料`"
                        :aria-describedby="`receipt-member-card-${member.id}`"
                      >
                        <UMessageAvatar :src="member.avatarUrl" :name="member.displayName" />
                      </button>
                    </template>
                    <UProfileCard
                      :id="`receipt-member-card-${member.id}`"
                      :display-name="member.displayName"
                      :login-name="member.loginName"
                      :avatar-url="member.avatarUrl"
                      :email="member.email"
                      :role="member.role === 'owner' ? 'owner' : 'member'"
                      :joined-at="member.joinedAt"
                    />
                  </UHoverCard>
                  <span class="member-name" :title="member.displayName">{{ member.displayName }}</span>
                </li>
              </ul>
            </li>
            <!-- 成员名单不可用（拉取失败 / 与 memberCount 不同步 / 无回执数据）时退回文字占位 -->
            <li v-else class="receipt-row-unread" data-test="receipt-row-unread"><span>未读 {{ unreadCount() }} 人</span></li>
          </template>
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
  padding: var(--unself-space-3) var(--unself-space-4) var(--unself-space-4);
  overflow-y: auto;
}
.receipt-section-label {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-secondary);
  margin-bottom: var(--unself-space-2);
}
.receipt-section-unread { margin-top: var(--unself-space-3); }
.receipt-section-count { color: var(--unself-color-text-tertiary); }

/* 头像网格：列宽 60px，头像居中、昵称单行截断 */
.member-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--unself-space-3);
}
.member-cell {
  width: 60px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--unself-space-1);
  min-width: 0;
}
.member-trigger { border: none; background: none; padding: 0; cursor: pointer; border-radius: var(--unself-radius-full); }
.member-trigger:focus-visible { outline: var(--unself-focus-ring); outline-offset: 2px; }
.member-cell-unread .member-trigger { opacity: 0.45; }
.member-name {
  max-width: 100%;
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.member-cell-unread .member-name { color: var(--unself-color-text-tertiary); }
/* 已读时间小字：比昵称（xs）再小一档，formatMessageTime 口径（当天 HH:mm / 昨天 / M月D日），已读格独有 */
.member-time {
  font-size: var(--unself-font-size-2xs);
  color: var(--unself-color-text-tertiary);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

/* 成员名单降级时的未读文字占位（保留 #220 原样式口径） */
.receipt-row-unread {
  display: flex;
  align-items: baseline;
  gap: var(--unself-space-3);
  padding: var(--unself-space-2) 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-tertiary);
}
</style>
