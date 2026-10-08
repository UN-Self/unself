// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { Hash, Lock, MessageCircle } from 'lucide-vue-next'
import { computed } from 'vue'

import { USkeleton } from '@unself/ui'
import type { Channel, Dm, RoomKind } from '../lib/types'

/**
 * 会话列表（#218 布局左栏）：频道 + 私聊两种段，桌面双栏里常驻，窄屏切换为列表页。
 * 排序/未读角标数据由 props 直入（T2 的 SDK 侧 store 出），本组件零副作用。
 */
export interface RoomListProps {
  channels: Channel[]
  dms: Dm[]
  /** 当前选中房间 {kind, id}；null = 未选中（窄屏首屏态）。 */
  activeRoom: { kind: RoomKind; id: number } | null
  loading: boolean
  /** 加载失败人话提示（live 401/网络故障等）：错误态替代「暂无会话」空态（#221 走查补）。 */
  loadError?: string | null
}

const props = withDefaults(defineProps<RoomListProps>(), {
  activeRoom: null,
  loading: false,
  loadError: null,
})

const emit = defineEmits<{
  /** 选中一个会话（频道/私聊通用）。 */
  select: [room: { kind: RoomKind; id: number }]
}>()

const hasAny = computed(() => props.channels.length > 0 || props.dms.length > 0)

function isActive(kind: RoomKind, id: number): boolean {
  return props.activeRoom?.kind === kind && props.activeRoom.id === id
}

function lastActivity(value: string | null): string {
  if (!value) return ''
  const date = new Date(value.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}
</script>

<template>
  <nav class="rooms" data-test="room-list" aria-label="会话列表">
    <USkeleton v-if="loading" :lines="5" />

    <template v-else>
      <div v-if="props.loadError" class="rooms-empty" data-test="rooms-error" role="alert">
        <MessageCircle :size="20" aria-hidden="true" />
        <span>{{ props.loadError }}</span>
      </div>

      <div v-else-if="!hasAny" class="rooms-empty" data-test="rooms-empty">
        <MessageCircle :size="20" aria-hidden="true" />
        <span>暂无会话</span>
      </div>

      <template v-if="channels.length">
        <p class="rooms-section">频道</p>
        <ul class="rooms-items">
          <li v-for="channel in channels" :key="`c-${channel.id}`">
            <button
              type="button"
              class="rooms-item"
              :class="{ 'rooms-item-active': isActive(channel.kind, channel.id) }"
              :data-test="`room-channel-${channel.id}`"
              :aria-current="isActive(channel.kind, channel.id) ? 'true' : undefined"
              @click="emit('select', { kind: channel.kind, id: channel.id })"
            >
              <span class="rooms-icon" aria-hidden="true">
                <Lock v-if="channel.kind === 'private'" :size="17" />
                <Hash v-else :size="17" />
              </span>
              <span class="rooms-item-copy"><span class="rooms-item-name">{{ channel.name }}</span><small>{{ channel.description || `${channel.memberCount} 位成员` }}</small></span>
              <span v-if="channel.lastMessageAt" class="rooms-time">{{ lastActivity(channel.lastMessageAt) }}</span>
              <span v-if="channel.unreadCount > 0" class="rooms-badge" data-test="unread-badge">
                {{ channel.unreadCount > 99 ? '99+' : channel.unreadCount }}
              </span>
            </button>
          </li>
        </ul>
      </template>

      <template v-if="dms.length">
        <p class="rooms-section">私聊</p>
        <ul class="rooms-items">
          <li v-for="dm in dms" :key="`d-${dm.id}`">
            <button
              type="button"
              class="rooms-item"
              :class="{ 'rooms-item-active': isActive('dm', dm.id) }"
              :data-test="`room-dm-${dm.id}`"
              :aria-current="isActive('dm', dm.id) ? 'true' : undefined"
              @click="emit('select', { kind: 'dm', id: dm.id })"
            >
              <span class="rooms-icon rooms-icon-dm" aria-hidden="true">
                {{ (dm.otherUser.displayName || dm.name).slice(0, 1) }}
              </span>
              <span class="rooms-item-copy"><span class="rooms-item-name">{{ dm.otherUser.displayName || dm.name }}</span><small>@{{ dm.otherUser.username }}</small></span>
              <span v-if="dm.lastMessageAt" class="rooms-time">{{ lastActivity(dm.lastMessageAt) }}</span>
              <span v-if="dm.unreadCount > 0" class="rooms-badge" data-test="unread-badge">
                {{ dm.unreadCount > 99 ? '99+' : dm.unreadCount }}
              </span>
            </button>
          </li>
        </ul>
      </template>
    </template>
  </nav>
</template>

<style scoped>
.rooms {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
  height: 100%;
  overflow-y: auto;
  padding: var(--unself-space-3);
  scrollbar-width: thin;
}
.rooms-empty {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  padding: var(--unself-space-4);
  color: var(--unself-color-text-tertiary);
  font-size: var(--unself-font-size-sm);
}
.rooms-section {
  margin: var(--unself-space-4) 0 var(--unself-space-1);
  padding: 0 var(--unself-space-2);
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
  font-weight: 600;
}
.rooms-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
}
.rooms-item {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  width: 100%;
  min-height: 58px;
  padding: var(--unself-space-1) var(--unself-space-2);
  border: none;
  border-radius: var(--unself-radius-md);
  background: transparent;
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-base);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--unself-duration-fast) var(--unself-ease-out),
    color var(--unself-duration-fast) var(--unself-ease-out);
}
.rooms-item:hover {
  background: var(--unself-color-surface-hover);
  color: var(--unself-color-text);
}
.rooms-item:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: -2px;
}
.rooms-item-active {
  background: var(--unself-color-surface-active);
  color: var(--unself-color-primary);
  font-weight: 600;
}
.rooms-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-surface);
  color: var(--unself-color-text-secondary);
}
.rooms-icon-dm {
  border-radius: var(--unself-radius-full);
  background: var(--unself-color-primary-soft);
  color: var(--unself-color-primary);
  font-weight: 600;
}
.rooms-item-active .rooms-icon {
  color: var(--unself-color-primary);
}
.rooms-item-name {
  display:block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rooms-item-copy { display:block; flex:1; min-width:0; }
.rooms-item-copy small { display:block; margin-top:var(--unself-space-1); overflow:hidden; color:var(--unself-color-text-tertiary); font-size:var(--unself-font-size-xs); font-weight:400; text-overflow:ellipsis; white-space:nowrap; }
.rooms-time { align-self:flex-start; padding-top:var(--unself-space-2); color:var(--unself-color-text-tertiary); font-size:var(--unself-font-size-xs); font-variant-numeric:tabular-nums; }
.rooms-badge {
  flex-shrink: 0;
  min-width: 18px;
  padding: 0 6px;
  border-radius: var(--unself-radius-full);
  background: var(--unself-color-primary);
  color: var(--unself-color-bg);
  font-size: var(--unself-font-size-xs);
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
</style>
