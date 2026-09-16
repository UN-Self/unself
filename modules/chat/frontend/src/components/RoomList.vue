// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { Hash, Lock, MessageCircle, Users } from 'lucide-vue-next'
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
              <Lock v-if="channel.kind === 'private'" :size="14" aria-hidden="true" />
              <Hash v-else :size="14" aria-hidden="true" />
              <span class="rooms-item-name">{{ channel.name }}</span>
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
              <Users :size="14" aria-hidden="true" />
              <span class="rooms-item-name">{{ dm.otherUser.displayName || dm.name }}</span>
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
  gap: var(--unself-space-1);
  height: 100%;
  overflow-y: auto;
  padding: var(--unself-space-2);
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
  margin: var(--unself-space-2) 0 0;
  padding: 0 var(--unself-space-2);
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
  letter-spacing: 0.05em;
}
.rooms-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rooms-item {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  width: 100%;
  min-height: 36px;
  padding: 0 var(--unself-space-2);
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
  color: var(--unself-color-text);
  font-weight: 500;
}
.rooms-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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
