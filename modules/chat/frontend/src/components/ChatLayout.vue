// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { ArrowLeft, Hash, Lock } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import MessageList from './MessageList.vue'
import RoomList from './RoomList.vue'
import { USkeleton } from '@unself/ui'
import { NARROW_MAX_PX, type MediaQueryLike } from '../lib/viewport'
import type { Channel, Dm, Message, RoomKind } from '../lib/types'

/**
 * 聊天布局骨架（#218，worker A）：桌面（>768px）双栏 = 会话列表 + 消息流；
 * 窄屏（≤768px，--unself-bp-md）单栏 = 列表/消息流二选一 + 顶栏返回。
 * 断点判定唯一源 = matchMedia（视口真实值），JS 侧字面量对齐 tokens.css --unself-bp-md。
 * 数据接线（T2/T5）：props 进 + emits 出，本组件不取数。
 */
export interface ChatLayoutProps {
  channels: Channel[]
  dms: Dm[]
  /** 当前房间；null = 未选中（窄屏显示列表，桌面显示空占位）。 */
  activeRoom: { kind: RoomKind; id: number; name: string } | null
  messages: Message[]
  currentUserId: number
  loadingRooms: boolean
  loadingMessages: boolean
  loadingEarlier: boolean
  noEarlier: boolean
}

const props = withDefaults(defineProps<ChatLayoutProps>(), {
  activeRoom: null,
})

const emit = defineEmits<{
  select: [room: { kind: RoomKind; id: number }]
  back: []
  'load-earlier': []
}>()

/** 响应式窄屏判定：跟随 matchMedia 翻转并回调；无 matchMedia 环境降级恒 false（桌面布局）。 */
function useNarrow(onChange: (narrow: boolean) => void): { matches: boolean; dispose: () => void } {
  let matches = false
  let mql: MediaQueryLike | null = null
  let listener: ((event: { matches: boolean }) => void) | null = null
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mql = window.matchMedia(`(max-width: ${NARROW_MAX_PX}px)`) as MediaQueryLike
    matches = mql.matches
    listener = (event) => {
      matches = event.matches
      onChange(matches)
    }
    mql.addEventListener('change', listener)
  }
  return {
    get matches() {
      return matches
    },
    dispose: () => {
      if (mql !== null && listener !== null) mql.removeEventListener('change', listener)
    },
  }
}

const narrow = ref(false)
let media: { matches: boolean; dispose: () => void } | null = null

onMounted(() => {
  media = useNarrow((value) => {
    narrow.value = value
  })
  narrow.value = media.matches
})

onBeforeUnmount(() => {
  media?.dispose()
  media = null
})

const hasRoom = computed(() => props.activeRoom !== null)

/** 窄屏下：有选中房间 → 显示消息流页；否则列表页。桌面双栏同屏。 */
const showListPane = computed(() => !narrow.value || !hasRoom.value)
const showRoomPane = computed(() => !narrow.value || hasRoom.value)

const roomIcon = computed(() => {
  if (props.activeRoom === null) return Hash
  return props.activeRoom.kind === 'private' ? Lock : Hash
})
</script>

<template>
  <div class="chat" data-test="chat-layout">
    <!-- 左栏：会话列表（窄屏=整页，桌面=双栏左列） -->
    <section v-if="showListPane" class="chat-list" data-test="list-pane">
      <header class="chat-list-head">
        <span class="chat-title">聊天</span>
      </header>
      <RoomList
        :channels="channels"
        :dms="dms"
        :active-room="activeRoom ? { kind: activeRoom.kind, id: activeRoom.id } : null"
        :loading="loadingRooms"
        @select="emit('select', $event)"
      />
    </section>

    <!-- 右栏：消息流（窄屏=选中后整页，桌面=双栏右列） -->
    <section v-if="showRoomPane" class="chat-room" data-test="room-pane">
      <header class="chat-room-head">
        <!-- 窄屏返回（桌面无此钮——点左栏即切换） -->
        <button
          v-if="narrow"
          type="button"
          class="chat-back"
          data-test="back-button"
          @click="emit('back')"
        >
          <ArrowLeft :size="16" aria-hidden="true" />
          返回
        </button>
        <component :is="roomIcon" :size="16" aria-hidden="true" />
        <span class="chat-room-title" data-test="room-title">
          {{ activeRoom?.name ?? '' }}
        </span>
      </header>

      <div v-if="loadingMessages" class="chat-room-loading" data-test="messages-loading">
        <USkeleton :lines="4" />
      </div>
      <MessageList
        v-else
        :messages="messages"
        :current-user-id="currentUserId"
        :loading-earlier="loadingEarlier"
        :no-earlier="noEarlier"
        @load-earlier="emit('load-earlier')"
      />

      <!-- composer 插槽：T4/T5 填充（发送/@/文件/语音入口） -->
      <div class="chat-composer-slot">
        <slot name="composer" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--unself-color-bg);
  color: var(--unself-color-text);
}

/* ---------- 桌面双栏 ---------- */
.chat-list {
  display: flex;
  flex-direction: column;
  width: 264px;
  flex-shrink: 0;
  border-right: 1px solid var(--unself-color-border);
  background: var(--unself-color-surface);
  min-height: 0;
}
.chat-room {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.chat-list-head {
  padding: var(--unself-space-3) var(--unself-space-4);
  border-bottom: 1px solid var(--unself-color-border);
}
.chat-title {
  font-size: var(--unself-font-size-lg);
  font-weight: 600;
}

.chat-room-head {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  min-height: var(--unself-touch-target);
  padding: 0 var(--unself-space-4);
  border-bottom: 1px solid var(--unself-color-border);
  color: var(--unself-color-text-secondary);
}
.chat-room-title {
  font-size: var(--unself-font-size-base);
  font-weight: 500;
  color: var(--unself-color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-back {
  display: inline-flex;
  align-items: center;
  gap: var(--unself-space-1);
  min-height: 36px;
  padding: 0 var(--unself-space-2);
  margin-left: calc(-1 * var(--unself-space-2));
  border: none;
  border-radius: var(--unself-radius-md);
  background: transparent;
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-sm);
  cursor: pointer;
  transition: background-color var(--unself-duration-fast) var(--unself-ease-out);
}
.chat-back:hover {
  background: var(--unself-color-surface-hover);
  color: var(--unself-color-text);
}
.chat-back:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}

.chat-room-loading {
  flex: 1;
  padding: var(--unself-space-4);
}

.chat-composer-slot {
  border-top: 1px solid var(--unself-color-border);
}

/* ---------- 窄屏单栏（≤768px = tokens.css --unself-bp-md） ---------- */
@media (max-width: 768px) {
  .chat {
    flex-direction: column;
  }
  .chat-list {
    width: 100%;
    flex: 1;
    border-right: none;
  }
  .chat-room {
    position: absolute;
    inset: 0;
    z-index: 1;
    background: var(--unself-color-bg);
  }
}
</style>
