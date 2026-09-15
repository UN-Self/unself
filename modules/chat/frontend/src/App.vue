<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

import ChatLayout from './components/ChatLayout.vue'
import Composer from './components/Composer.vue'
import { createChatApi, type ChatApi } from './lib/api'
import { createChatStore, roomKeyString } from './lib/chat-store'
import { createMockChatApi } from './lib/mock-api'
import { createChatSession, userIdFromToken } from './lib/session'
import { createChatStorage } from './lib/storage'
import type { Message, RoomKind, UserSummary } from './lib/types'

/**
 * 聊天模块根视图（#218 T5 合成）：mock/live 双模式接线。
 * - 默认 mock：#216 worker 未部署时的全链路走查（数据内存闭环 + WS 广播语义一致）。
 * - live：VITE_CHAT_API=live 构建变量切换（Bearer=模块 token，同源 /api/*）。
 * 握手：SDK ready → token → startTokenLoop 静默续期；token 失效时重新握手换新后重试一次。
 */
const MODE: 'mock' | 'live' = import.meta.env.VITE_CHAT_API === 'live' ? 'live' : 'mock'

const session = createChatSession()
const storage = createChatStorage()

const chatApi: ChatApi =
  MODE === 'live'
    ? createChatApi({ getToken: () => session.getToken() })
    : createMockChatApi()

const store = createChatStore({
  api: chatApi,
  storage,
  myUserId: () => {
    const id = userIdFromToken((token) => session.sdk.decodeContext(token), session.getToken())
    if (id) return id
    return MODE === 'mock' ? (chatApi as ReturnType<typeof createMockChatApi>).world.me.id : 0
  },
  getToken: () => session.getToken(),
})

// ---------- 握手生命周期 ----------

const handshakeError = ref('')
const handshakeReady = ref(false)

async function bootstrap(): Promise<void> {
  try {
    await session.handshake()
    handshakeReady.value = true
    void store.loadChannels()
    void store.loadDms()
    void store.loadContacts()
    // 恢复上次会话（unself.chat.last-room，仅界面偏好）
    const last = storage.getJSON<{ kind: RoomKind; id: number } | null>('last-room', null)
    if (last) {
      const name = displayNameFor(last)
      void store.openRoom(last, name)
    }
  } catch (error) {
    handshakeError.value = error instanceof Error ? error.message : String(error)
  }
}
void bootstrap()

onBeforeUnmount(() => {
  store.closeSockets()
  session.dispose()
})

// ---------- 会话选择（动态状态一律走 store.state reactive 源） ----------

function displayNameFor(room: { kind: RoomKind; id: number }): string {
  if (room.kind === 'dm') {
    return store.state.dms.find((d) => d.id === room.id)?.otherUser.displayName ?? ''
  }
  return store.state.channels.find((c) => c.id === room.id)?.name ?? ''
}

const activeRoom = computed(() => {
  const room = store.state.currentRoom
  if (!room) return null
  return { kind: room.kind, id: room.id, name: store.state.roomName || displayNameFor(room) }
})

const contacts = computed<UserSummary[]>(() => store.state.contacts)

function onSelect(room: { kind: RoomKind; id: number }): void {
  void store.openRoom(room, displayNameFor(room))
}

function onBack(): void {
  store.closeSockets()
  store.state.currentRoom = null
}

// ---------- composer 编排 ----------

const replyTo = ref<Message | null>(null)
const uploading = ref(false)
const uploadProgress = ref(0)

async function onSend(text: string, mentionUserIds: number[]): Promise<void> {
  try {
    await store.sendMessage({ content: text, mentionUserIds })
    replyTo.value = null
  } catch {
    // 发送失败：sendError 已由 store 置为人话提示（发送态复原，输入不丢可重试）
  }
}

async function onSendFile(file: File): Promise<void> {
  uploading.value = true
  uploadProgress.value = 8
  try {
    const attachment = await store.uploadFile(file)
    if (!attachment) return
    uploadProgress.value = 100
    await store.sendMessage({ content: '', attachment })
  } finally {
    uploading.value = false
    uploadProgress.value = 0
  }
}

async function onSendVoice(recording: {
  file: File
  durationMs: number
  waveform: number[]
}): Promise<void> {
  uploading.value = true
  try {
    const uploaded = await store.uploadFile(recording.file)
    if (!uploaded) return
    await store.sendMessage({
      content: '',
      attachment: {
        ...uploaded,
        kind: 'voice',
        durationMs: recording.durationMs,
        waveform: recording.waveform,
      },
    })
  } finally {
    uploading.value = false
  }
}

// 上传进度：fetch 无原生上传进度，阶段值（选中 8% → 完成 100%）；
// 真流式进度（XHR onprogress）归 #216 联调期按需升级。

// ---------- MessageList 分页 ----------

function onLoadEarlier(): void {
  void store.loadOlderMessages()
}

const contextKey = computed(() =>
  store.state.currentRoom ? roomKeyString(store.state.currentRoom) : '',
)
</script>

<template>
  <div class="chat-root">
    <div v-if="handshakeError" class="chat-root-error" data-test="handshake-error" role="alert">
      {{ handshakeError }}
    </div>

    <ChatLayout
      v-else-if="handshakeReady"
      :channels="store.state.channels"
      :dms="store.state.dms"
      :active-room="activeRoom"
      :messages="store.state.messages"
      :current-user-id="store.state.myUserId"
      :loading-rooms="store.state.channelsState === 'loading' && store.state.dmsState === 'loading'"
      :loading-messages="
        store.state.loadingHistory === 'loading' && store.state.messages.length === 0
      "
      :loading-earlier="
        store.state.loadingHistory === 'loading' && store.state.messages.length > 0
      "
      :no-earlier="!store.state.hasMoreHistory"
      @select="onSelect"
      @back="onBack"
      @load-earlier="onLoadEarlier"
    >
      <template #composer>
        <Composer
          v-if="store.state.currentRoom"
          :key="contextKey"
          :context-key="contextKey"
          :disabled="store.state.realtimeStatus === 'error'"
          :sending="store.state.sending"
          :uploading="uploading"
          :upload-progress="uploadProgress"
          :reply-to="replyTo"
          :contacts="contacts"
          @send="onSend"
          @send-file="onSendFile"
          @send-voice="onSendVoice"
          @cancel-reply="replyTo = null"
        />
      </template>
    </ChatLayout>

    <div v-else class="chat-root-boot" data-test="handshaking" aria-busy="true">
      <p>正在连接模块…</p>
    </div>
  </div>
</template>

<style scoped>
.chat-root {
  height: 100%;
  min-height: 0;
  position: relative;
}
.chat-root-error {
  padding: var(--unself-space-6);
  color: var(--unself-color-danger);
  font-size: var(--unself-font-size-base);
}
.chat-root-boot {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--unself-color-text-tertiary);
  font-size: var(--unself-font-size-sm);
}
</style>
