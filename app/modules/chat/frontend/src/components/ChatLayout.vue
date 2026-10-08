// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { ArrowLeft, Hash, Lock, UserPlus, Users, X } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import MessageList from './MessageList.vue'
import RoomList from './RoomList.vue'
import { UButton, USkeleton } from '@unself/ui'
import { NARROW_MAX_PX, type MediaQueryLike } from '../lib/viewport'
import type { Channel, Dm, Message, RoomKind, UserSummary } from '../lib/types'

/**
 * 聊天布局骨架（#218，worker A）：桌面（>768px）双栏 = 会话列表 + 消息流；
 * 窄屏（≤768px，--unself-bp-md）单栏 = 列表/消息流二选一 + 顶栏返回。
 * 断点判定唯一源 = matchMedia（视口真实值），JS 侧字面量对齐 tokens.css --unself-bp-md。
 * 数据接线（T2/T5）：props 进 + emits 出，本组件不取数。
 */
export interface ChatLayoutProps {
  channels: Channel[]
  dms: Dm[]
  contacts?: UserSummary[]
  /** 当前房间；null = 未选中（窄屏显示列表，桌面显示空占位）。 */
  activeRoom: { kind: RoomKind; id: number; name: string } | null
  messages: Message[]
  currentUserId: number
  loadingRooms: boolean
  loadingMessages: boolean
  loadingEarlier: boolean
  noEarlier: boolean
  /** 当前会话是否私聊（#220：透传给 MessageList/气泡，DM 回执 = 已读 ✓✓）。 */
  isDm?: boolean
  /** 可达收件人数（#220 分母：房间成员−发件人；未知传 0，气泡只显示已读数或未读）。 */
  audienceSize?: number
  /** 回执摘要唯一真值（#220 store.state.readReceipts；缺省 = 旧格式无回执面）。 */
  readReceipts?: Record<number, import('../lib/types').ReadReceiptsSummary>
  /** 会话列表加载失败人话（#221 走查补：错误态替代空态，不再静默吞错）。 */
  loadError?: string | null
}

const props = withDefaults(defineProps<ChatLayoutProps>(), {
  activeRoom: null,
  isDm: false,
  audienceSize: 0,
  readReceipts: () => ({}),
  loadError: null,
  contacts: () => [],
})

const emit = defineEmits<{
  select: [room: { kind: RoomKind; id: number }]
  back: []
  'load-earlier': []
  /** 点击 mine 气泡回执标签 → 根层开已读名单浮层（#220）。 */
  'show-receipts': [message: Message]
  /** 他人消息进入视口 → 根层批量上报已读（#220）。 */
  'visible-read': [messageIds: number[]]
  'open-dm': [userId: number]
  'create-group': [input: { name: string; memberUserIds: number[] }]
  'open-group-details': []
}>()

const newMessageOpen = ref(false)
const contactQuery = ref('')
const filteredContacts = computed(() => props.contacts.filter((contact) =>
  `${contact.displayName} ${contact.username}`.toLowerCase().includes(contactQuery.value.trim().toLowerCase()),
))
const groupOpen = ref(false)
const groupName = ref('')
const selectedMemberIds = ref<number[]>([])

function toggleMember(userId: number): void {
  selectedMemberIds.value = selectedMemberIds.value.includes(userId)
    ? selectedMemberIds.value.filter((id) => id !== userId)
    : [...selectedMemberIds.value, userId]
}

function submitGroup(): void {
  const name = groupName.value.trim()
  if (!name) return
  emit('create-group', { name, memberUserIds: [...selectedMemberIds.value] })
  groupName.value = ''
  selectedMemberIds.value = []
  groupOpen.value = false
  newMessageOpen.value = false
}

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
const activeChannel = computed(() => props.activeRoom?.kind === 'dm'
  ? null
  : props.channels.find((channel) => channel.id === props.activeRoom?.id),
)
</script>

<template>
  <div class="chat" data-test="chat-layout">
    <!-- 左栏：会话列表（窄屏=整页，桌面=双栏左列） -->
    <section v-if="showListPane" class="chat-list" data-test="list-pane">
      <header class="chat-list-head">
        <span class="chat-title">聊天</span>
        <button type="button" class="chat-new-message" data-test="new-message" aria-label="新建私聊" @click="newMessageOpen = !newMessageOpen">
          <UserPlus :size="17" aria-hidden="true" />
          <span>新消息</span>
        </button>
        <div v-if="newMessageOpen" class="chat-new-message-menu" role="menu" aria-label="新消息">
          <p class="chat-menu-label">新建对话</p>
          <input v-model="contactQuery" class="chat-contact-search" aria-label="搜索联系人" placeholder="搜索联系人" />
            <button
              v-for="contact in filteredContacts"
              :key="contact.id"
              type="button"
              role="menuitem"
              @click="emit('open-dm', contact.id); newMessageOpen = false"
            >
              <span class="chat-contact-avatar">{{ (contact.displayName || contact.username).slice(0, 1) }}</span>
              {{ contact.displayName || contact.username }}
            </button>
            <button type="button" role="menuitem" @click="groupOpen = true">
              <Users :size="16" aria-hidden="true" />
              新建群组
            </button>
        </div>
      </header>
      <RoomList
        :channels="channels"
        :dms="dms"
        :load-error="loadError"
        :active-room="activeRoom ? { kind: activeRoom.kind, id: activeRoom.id } : null"
        :loading="loadingRooms"
        @select="emit('select', $event)"
      />
    </section>

    <!-- 右栏：消息流（窄屏=选中后整页，桌面=双栏右列） -->
    <section v-if="showRoomPane" class="chat-room" data-test="room-pane">
      <header class="chat-room-head">
        <!-- 窄屏返回（桌面无此钮——点左栏即切换） -->
        <UButton
          v-if="narrow"
          type="button"
          variant="ghost"
          size="sm"
          class="chat-back"
          data-test="back-button"
          @click="emit('back')"
        >
          <ArrowLeft :size="16" aria-hidden="true" />
          返回
        </UButton>
        <component :is="roomIcon" :size="16" aria-hidden="true" />
        <button type="button" class="chat-room-title-button" :disabled="!activeRoom || activeRoom.kind === 'dm'" @click="emit('open-group-details')">
          <span class="chat-room-title" data-test="room-title">{{ activeRoom?.name ?? '' }}</span>
          <small v-if="activeChannel">{{ activeChannel.memberCount }} 位成员</small>
        </button>
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
        :is-dm="isDm"
        :audience-size="audienceSize"
        :read-receipts="readReceipts"
        @load-earlier="emit('load-earlier')"
        @show-receipts="emit('show-receipts', $event)"
        @visible-read="emit('visible-read', $event)"
      />

      <!-- composer 插槽：T4/T5 填充（发送/@/文件/语音入口） -->
      <div class="chat-composer-slot">
        <slot name="composer" />
      </div>
    </section>

    <div v-if="groupOpen" class="chat-modal-backdrop" role="presentation" @click.self="groupOpen = false">
      <section class="chat-modal" role="dialog" aria-modal="true" aria-labelledby="group-title">
        <header class="chat-modal-head">
          <div><p class="chat-eyebrow">新消息</p><h2 id="group-title">新建群组</h2></div>
          <button type="button" class="chat-icon-button" aria-label="关闭" @click="groupOpen = false"><X :size="18" /></button>
        </header>
        <label class="chat-field">群组名称<input v-model="groupName" data-test="group-name" placeholder="例如：项目讨论群" /></label>
        <p class="chat-field-label">选择成员</p>
        <div class="chat-member-picker">
          <button v-for="contact in filteredContacts" :key="contact.id" type="button" class="chat-member-option" :class="{ selected: selectedMemberIds.includes(contact.id) }" @click="toggleMember(contact.id)">
            <span class="chat-contact-avatar">{{ (contact.displayName || contact.username).slice(0, 1) }}</span>
            <span>{{ contact.displayName || contact.username }}</span>
            <span class="chat-check" aria-hidden="true">{{ selectedMemberIds.includes(contact.id) ? '✓' : '' }}</span>
          </button>
        </div>
        <footer class="chat-modal-actions"><button type="button" class="chat-secondary-button" @click="groupOpen = false">取消</button><UButton type="button" size="md" :disabled="!groupName.trim()" @click="submitGroup">创建群组</UButton></footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--unself-color-surface);
  color: var(--unself-color-text);
}

/* ---------- 桌面双栏 ---------- */
.chat-list {
  display: flex;
  flex-direction: column;
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid var(--unself-color-border);
  background: var(--unself-color-bg);
  min-height: 0;
}
.chat-list-head {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-3);
  min-height: 64px;
  box-sizing: border-box;
}
.chat-new-dm {
  position: relative;
}
.chat-new-message {
  display: inline-flex;
  align-items: center;
  gap: var(--unself-space-2);
  min-height: 36px;
  padding: 0 var(--unself-space-2);
  border: 0;
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-primary-soft);
  color: var(--unself-color-primary);
  font: inherit;
  font-size: var(--unself-font-size-sm);
  font-weight: 600;
  cursor: pointer;
}
.chat-new-message:hover { background: var(--unself-color-surface-active); }
.chat-new-message-menu {
  position: absolute;
  z-index: 3;
  top: calc(100% - var(--unself-space-2));
  right: var(--unself-space-4);
  width: 220px;
  padding: var(--unself-space-2);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg);
  box-shadow: var(--unself-shadow-pop);
}
.chat-menu-label, .chat-eyebrow, .chat-field-label { margin: var(--unself-space-2); color: var(--unself-color-text-tertiary); font-size: var(--unself-font-size-xs); font-weight: 600; }
.chat-new-message-menu button { display:flex; align-items:center; gap: var(--unself-space-2); width:100%; padding: var(--unself-space-2); border:0; border-radius:var(--unself-radius-sm); background:transparent; color:var(--unself-color-text); text-align:left; font:inherit; cursor:pointer; }
.chat-new-message-menu button:hover { background: var(--unself-color-surface-hover); }
.chat-contact-search { width:100%; box-sizing:border-box; min-height:36px; margin-bottom:var(--unself-space-2); padding:0 var(--unself-space-2); border:1px solid var(--unself-color-border); border-radius:var(--unself-radius-md); background:var(--unself-color-bg); color:var(--unself-color-text); font:inherit; }
.chat-contact-avatar { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; flex:0 0 28px; border-radius:var(--unself-radius-full); background:var(--unself-color-primary-soft); color:var(--unself-color-primary); font-size:var(--unself-font-size-sm); font-weight:600; }
.chat-new-dm summary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--unself-touch-target);
  min-height: var(--unself-touch-target);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg);
  color: var(--unself-color-text-secondary);
  cursor: pointer;
  list-style: none;
}
.chat-new-dm summary::-webkit-details-marker {
  display: none;
}
.chat-new-dm summary:hover,
.chat-new-dm summary:focus-visible {
  background: var(--unself-color-surface-hover);
  color: var(--unself-color-text);
}
.chat-new-dm-menu {
  position: absolute;
  z-index: 2;
  top: calc(100% + var(--unself-space-1));
  right: 0;
  display: grid;
  min-width: 12rem;
  padding: var(--unself-space-1);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg);
  box-shadow: var(--unself-shadow-pop);
}
.chat-new-dm-menu button {
  padding: var(--unself-space-2) var(--unself-space-3);
  border: 0;
  background: transparent;
  color: var(--unself-color-text);
  text-align: left;
  cursor: pointer;
  border-radius: var(--unself-radius-sm);
}
.chat-new-dm-menu button:hover,
.chat-new-dm-menu button:focus-visible {
  background: var(--unself-color-surface-hover);
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
  min-height: 64px;
  padding: 0 var(--unself-space-6);
  background: var(--unself-color-bg);
  border-bottom: 1px solid var(--unself-color-border);
  color: var(--unself-color-text-secondary);
}
.chat-room-title {
  font-size: var(--unself-font-size-base);
  font-weight: 600;
  color: var(--unself-color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-room-title-button { display:flex; align-items:center; gap:var(--unself-space-2); padding:0; border:0; background:transparent; color:inherit; text-align:left; cursor:pointer; }
.chat-room-title-button small { color:var(--unself-color-text-tertiary); font-size:var(--unself-font-size-xs); font-weight:400; }
.chat-room-title-button:disabled { cursor:default; }
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
  padding: var(--unself-space-6);
}

.chat-composer-slot {
  background: var(--unself-color-bg);
}
.chat-modal-backdrop { position:absolute; inset:0; z-index:5; display:grid; place-items:center; padding:var(--unself-space-4); background:color-mix(in srgb, var(--unself-color-text) 18%, transparent); }
.chat-modal { width:min(420px, 100%); max-height:min(620px, 100%); overflow:auto; padding:var(--unself-space-5); border:1px solid var(--unself-color-border); border-radius:var(--unself-radius-lg); background:var(--unself-color-bg); box-shadow:var(--unself-shadow-pop); }
.chat-modal-head, .chat-modal-actions { display:flex; align-items:center; justify-content:space-between; gap:var(--unself-space-3); }
.chat-modal h2 { margin:0 0 var(--unself-space-4); font-size:var(--unself-font-size-lg); }
.chat-icon-button, .chat-secondary-button { border:0; border-radius:var(--unself-radius-md); background:transparent; color:var(--unself-color-text-secondary); cursor:pointer; }
.chat-icon-button { display:grid; place-items:center; width:36px; height:36px; }
.chat-field { display:grid; gap:var(--unself-space-2); color:var(--unself-color-text-secondary); font-size:var(--unself-font-size-sm); }
.chat-field input { min-height:40px; box-sizing:border-box; padding:0 var(--unself-space-3); border:1px solid var(--unself-color-border); border-radius:var(--unself-radius-md); background:var(--unself-color-bg); color:var(--unself-color-text); font:inherit; }
.chat-member-picker { display:grid; gap:var(--unself-space-1); margin:0 0 var(--unself-space-5); }
.chat-member-option { display:flex; align-items:center; gap:var(--unself-space-2); padding:var(--unself-space-2); border:1px solid transparent; border-radius:var(--unself-radius-md); background:transparent; color:var(--unself-color-text); font:inherit; text-align:left; cursor:pointer; }
.chat-member-option:hover, .chat-member-option.selected { border-color:var(--unself-color-primary-soft); background:var(--unself-color-surface-active); }
.chat-check { margin-left:auto; color:var(--unself-color-primary); font-weight:700; }
.chat-secondary-button { padding:0 var(--unself-space-3); min-height:40px; }

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
  .chat-list-head,
  .chat-room-head {
    padding-left: var(--unself-space-4);
    padding-right: var(--unself-space-4);
  }
  .chat-room {
    position: absolute;
    inset: 0;
    z-index: 1;
    background: var(--unself-color-bg);
  }
}
</style>
