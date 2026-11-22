<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onBeforeUnmount, provide, ref, watch } from 'vue'

import { attachmentLoaderKey, createAttachmentLoader } from './lib/attachment-resource'
import { createDocumentSender, type ComposerDocument } from './lib/composer-document'

import ChatLayout from './components/ChatLayout.vue'
import Composer from './components/Composer.vue'
import ReadReceipts from './components/ReadReceipts.vue'
import GroupDetails from './components/GroupDetails.vue'
import ForwardDialog, { type ForwardTarget } from './components/ForwardDialog.vue'
import { createChatApi, type ChatApi } from './lib/api'
import { attachInboxSocket, createChatStore, roomKeyString } from './lib/chat-store'
import { createMockChatApi } from './lib/mock-api'
import { forwardSuccessTickKey } from './lib/forward-events'
import { createChatSession } from './lib/session'
import { createChatStorage } from './lib/storage'
import type { ChannelMember, Message, RoomKind, UserSummary } from './lib/types'

/**
 * 聊天模块根视图（#218 T5 合成）：mock/live 双模式接线。
 * - 默认 mock：#216 worker 未部署时的全链路走查（数据内存闭环 + WS 广播语义一致）。
 * - live：VITE_CHAT_API=live 构建变量切换（Bearer=模块 token，同源 /api/*）。
 * 握手：SDK ready → token → startTokenLoop 静默续期；token 失效时重新握手换新后重试一次。
 * #220：静默续期换新 → store.refreshSocketToken（WS 控制帧换绑，决策 #51）；
 * 可见性上报（visible-read）与已读名单浮层（ReadReceipts）在此装配。
 */
const MODE: 'mock' | 'live' = import.meta.env.VITE_CHAT_API === 'live' ? 'live' : 'mock'

// session 先建：store 的 refreshSocketToken 依赖其续期回调链（先 store 后 session 会丢首次接线）
const storage = createChatStorage()

// 先建占位引用（装配顺序：session 回调 → store；见下方接线）
let storeRef: ReturnType<typeof createChatStore> | null = null
let inboxHandle: { close(): void; send?(text: string): void } | null = null
const session = createChatSession({
  // #220/#225 live 接线：静默续期拿到新 token → 房间 socket 发 token_refresh 控制帧换绑
  onTokenRenewed: (token) => {
    storeRef?.refreshSocketToken(token)
    inboxHandle?.send?.(JSON.stringify({ type: 'token_refresh', token }))
    // #229：续期换新不影响 sub，但保险起见同步身份（token 过渡期保持 mine 判定连续）
    storeRef?.refreshMyUserId()
  },
})

if (MODE === 'live') provide(attachmentLoaderKey, createAttachmentLoader(() => session.getToken()))

const chatApi: ChatApi =
  MODE === 'live'
    ? createChatApi({ getToken: () => session.getToken() })
    : createMockChatApi()

const store = createChatStore({
  api: chatApi,
  storage,
  // #229：工厂内延迟求值（不再同步拍快照）。live：握手后 claims.sub 可用；
  // mock：主角 id 直接可用。chat 侧 id 由工厂经 contacts 解析（core:<sub> → id）。
  myUserId: () => MODE === 'mock'
    ? (chatApi as ReturnType<typeof createMockChatApi>).world.me.id
    : session.getUserId(),
  getToken: () => session.getToken(),
})
storeRef = store

// ---------- 握手生命周期 ----------

const handshakeError = ref('')
const handshakeReady = ref(false)

async function bootstrap(): Promise<void> {
  try {
    await session.handshake()
    handshakeReady.value = true
    inboxHandle = attachInboxSocket(store, chatApi, () => session.getToken())
    // #229：token 到位后重算本人身份（此前一次性求值早于握手 → live 恒 0）。
    // contacts 未载入时解析结果仍为 0，载入完成后（loadContacts 内）再重算一次。
    store.refreshMyUserId()
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
  inboxHandle?.close()
  inboxHandle = null
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
const groupDetailsOpen = ref(false)
const groupMembers = ref<ChannelMember[]>([])
const groupDetailsError = ref('')
const groupDetailsBusy = ref(false)
const groupCreationError = ref('')

/**
 * 消息头像资料卡的群内身份：进频道时拉一次成员名单，建 senderId → ChannelMember 映射传给消息气泡；
 * 拉取失败静默降级（卡片只显示昵称/句柄）。每次切频道重建，天然新鲜。
 */
const channelMemberMap = ref<Map<number, ChannelMember>>(new Map())
/** 把一份频道成员名单应用到资料卡映射：只在还停留在该频道时生效（请求期间可能已切走）。 */
function applyChannelMembers(roomId: number, members: ChannelMember[]): void {
  const current = store.state.currentRoom
  if (current && current.kind !== 'dm' && current.id === roomId) {
    channelMemberMap.value = new Map(members.map((member) => [member.id, member]))
  }
}
watch(
  () => store.state.currentRoom,
  (room) => {
    if (!room) {
      channelMemberMap.value = new Map()
      return
    }
    if (room.kind === 'dm') return // DM 走 dmMemberMap（响应式，无需拉取）
    void store.listChannelMembers(room.id).then((members) => {
      applyChannelMembers(room.id, members)
    }).catch(() => {
      // 失败同样只降自己：无条件清空会抹掉切走后新频道已填好的映射
      const current = store.state.currentRoom
      if (current && current.kind !== 'dm' && current.id === room.id) {
        channelMemberMap.value = new Map()
      }
    })
  },
  { immediate: true },
)

/**
 * DM 资料卡映射（computed，非拉取）：对方来自会话 otherUser（openDm 先写 state.dms 再切房间），
 * 自己来自 contacts（listContacts 不排除本人）——否则自己消息气泡的卡查不到 member，邮箱行凭空缺失。
 * contacts 晚到也会自动补上（reactive 源）。
 */
const chatMemberMap = computed<Map<number, ChannelMember>>(() => {
  const room = store.state.currentRoom
  if (!room) return new Map()
  if (room.kind === 'dm') {
    const entries: ChannelMember[] = []
    const other = store.state.dms.find((dm) => dm.id === room.id)?.otherUser
    if (other) entries.push({ ...other, role: 'member' })
    const me = store.state.contacts.find((user) => user.id === store.state.myUserId)
    if (me) entries.push({ ...me, role: 'member' })
    return new Map(entries.map((member) => [member.id, member]))
  }
  return channelMemberMap.value
})

function onSelect(room: { kind: RoomKind; id: number }): void {
  void store.openRoom(room, displayNameFor(room))
}

function onOpenDm(userId: number): void {
  void store.openDm(userId).catch((error) => {
    store.state.historyError = error instanceof Error ? error.message : String(error)
  })
}

function onCreateGroup(input: { name: string; memberUserIds: number[] }): void {
  groupCreationError.value = ''
  void store.createChannel({ ...input, kind: 'private' }).catch((error) => {
    groupCreationError.value = error instanceof Error ? error.message : String(error)
  })
}

function onBack(): void {
  store.closeSockets()
  store.state.currentRoom = null
}

async function onOpenGroupDetails(): Promise<void> {
  const room = store.state.currentRoom
  if (!room || room.kind === 'dm') return
  groupDetailsOpen.value = true
  groupDetailsError.value = ''
  groupDetailsBusy.value = true
  try {
    groupMembers.value = await store.listChannelMembers(room.id)
    applyChannelMembers(room.id, groupMembers.value) // 消息资料卡同步刷新（M1：打开面板即最新名单）
  } catch (error) {
    groupDetailsError.value = error instanceof Error ? error.message : String(error)
  } finally {
    groupDetailsBusy.value = false
  }
}

async function onInviteMembers(userIds: number[]): Promise<void> {
  const room = store.state.currentRoom
  if (!room || room.kind === 'dm') return
  groupDetailsBusy.value = true
  try {
    await store.inviteChannelMembers(room.id, userIds)
    groupMembers.value = await store.listChannelMembers(room.id)
    applyChannelMembers(room.id, groupMembers.value) // 新邀成员立即可在消息资料卡上查到身份
  } catch (error) {
    groupDetailsError.value = error instanceof Error ? error.message : String(error)
  } finally {
    groupDetailsBusy.value = false
  }
}

// ---------- #220 已读回执：可见性上报 + 名单浮层 ----------

function onVisibleRead(messageIds: number[]): void {
  void store.recordVisibleRead(messageIds)
}

async function onDeleteMessage(message: Message): Promise<void> {
  try {
    await store.deleteMessage(message.id)
  } catch (error) {
    store.state.sendError = error instanceof Error ? error.message : String(error)
  }
}

/** #221 走查补：会话列表加载失败 → 人话提示进列表位（错误态不再吞成空态）。 */
const roomsError = computed(() => {
  const st = store.state.channelsState === 'error' ? store.state.historyError : ''
  return st ? `会话加载失败：${st}` : null
})

/** 浮层开关状态由根层持有（子组件只 emit close）。 */
const receiptsOpen = ref(false)
const receiptTarget = ref<Message | null>(null)

function onShowReceipts(message: Message): void {
  receiptTarget.value = message
  receiptsOpen.value = true
}

function closeReceipts(): void {
  receiptsOpen.value = false
}

/** 当前会话是否私聊（DM 回执 = 单勾已读，#339③ 口径）。 */
const isDm = computed(() => store.state.currentRoom?.kind === 'dm')

/** 可达收件人数（分母 = 房间成员 − 发件人）：频道取 memberCount−1；DM 恒 1。 */
const audienceSize = computed(() => {
  const room = store.state.currentRoom
  if (!room) return 0
  if (room.kind === 'dm') return 1
  const channel = store.state.channels.find((c) => c.id === room.id)
  return Math.max(0, (channel?.memberCount ?? 0) - 1)
})

// ---------- composer 编排 ----------

const replyTo = ref<Message | null>(null)

// ---------- #347 转发：目标弹窗（状态由根层持有） ----------

// 基幂等键随本次转发一次性生成、重试复用（H1）：失败重试时目标房间不变、键不变，
// 服务端幂等回显挡掉已成功目标的重复落地；逐条模式的 -n 子键由服务端按序派生
function newForwardClientMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `cm-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
const forwardState = ref<{ mode: 'single' | 'merged'; messageIds: number[]; clientMessageId: string } | null>(null)
/** 弹窗开关与状态分离：失败后关弹窗不清 forwardState（键保留），重选同一批消息复用旧键走幂等回显。
 * 全清只发生在成功或切房——否则同批消息隔久的「有意重发」也会被旧键回显吞掉，表现为转不出去。 */
const forwardOpen = ref(false)
const forwardBusy = ref(false)
const forwardError = ref('')
// 转发整体成功计数（MessageList 清空多选勾选；provide/inject 直达，失败不增，勾选保留可换目标重试）
const forwardSuccessTick = ref(0)
provide(forwardSuccessTickKey, forwardSuccessTick)

/** 同一批（mode + 消息 id 集一致，id 序已由服务端归一，这里按集合比较）。 */
function sameForwardSelection(left: { mode: 'single' | 'merged'; messageIds: number[] }, right: { mode: 'single' | 'merged'; messageIds: number[] }): boolean {
  return left.mode === right.mode
    && left.messageIds.length === right.messageIds.length
    && left.messageIds.every((id) => right.messageIds.includes(id))
}

function onForward(payload: { mode: 'single' | 'merged'; messageIds: number[] }): void {
  // 失败重试（上次提交失败且勾选同批）：复用旧幂等键，已成功目标命中服务端回显不再重复落地；
  // 其余情况一律新键——包括成功后的有意重发，避免被旧回显吞掉。先判定再清 error，否则恒判非失败
  const retryable = forwardError.value !== '' && forwardState.value !== null && sameForwardSelection(forwardState.value, payload)
  const clientMessageId = retryable ? forwardState.value!.clientMessageId : newForwardClientMessageId()
  forwardError.value = ''
  forwardState.value = { ...payload, clientMessageId }
  forwardOpen.value = true
}

async function onForwardConfirm(targets: ForwardTarget[]): Promise<void> {
  if (!forwardState.value) return
  forwardBusy.value = true
  forwardError.value = ''
  try {
    await store.forwardMessages({ ...forwardState.value, targets })
    forwardSuccessTick.value += 1
    forwardState.value = null
    forwardOpen.value = false
  } catch (error) {
    // 失败保留 forwardState（forwardOpen 由关闭路径控制），重开同批消息时复用键
    forwardError.value = error instanceof Error ? error.message : String(error)
  } finally {
    forwardBusy.value = false
  }
}

function onForwardClose(): void {
  forwardOpen.value = false
  // 无失败的正常取消：状态即刻清掉；有失败则保留键供重试复用（见 forwardOpen 注释）
  if (forwardError.value === '') forwardState.value = null
}
const uploading = ref(false)
/** #347 右键头像 @：Composer 实例句柄（insertMention 外部插入入口）。 */
const composerView = ref<InstanceType<typeof Composer> | null>(null)

/** 右键消息头像 @ 提及：往输入框插入 mention chip（显示 @displayName，序列化 @username）。 */
function onMention(message: Message): void {
  const { id, username, displayName } = message.sender
  composerView.value?.insertMention({ id, username, displayName })
}

// 切房清引用：replyTo 指向的是上一条消息，换房后原房间已变，留着会把旧 replyMessageId 发到新房。
// 转发失败保留的幂等键同样只属于当前消息流，切房即弃（防隔久误复用）
watch(
  () => store.state.currentRoom,
  (room, previous) => {
    if (previous && (!room || room.id !== previous.id || room.kind !== previous.kind)) {
      replyTo.value = null
      forwardState.value = null
      forwardOpen.value = false
      forwardError.value = ''
    }
  },
)

async function onSend(text: string, mentionUserIds: number[], mentionAll = false): Promise<void> {
  try {
    await store.sendMessage({ content: text, mentionUserIds, mentionAll, replyTo: replyTo.value })
    replyTo.value = null
  } catch {
    // 发送失败：sendError 已由 store 置为人话提示（发送态复原，输入不丢可重试）
  }
}

// 文档发送同样消费引用：发送前快照并立即清条（避免上传期间回复条误导）；
// 失败恢复引用条，重试时文档仍带引用（与文本 onSend「失败保留」同语义）；
// 用户主动中止（signal.aborted）不算失败：不恢复，中止后随手发的文本不带旧引用
let documentReplyTo: Message | null = null
const sendDocument = createDocumentSender({
  getRoomKey: () => store.state.currentRoom ? roomKeyString(store.state.currentRoom) : null,
  upload: (file) => store.uploadFile(file),
  send: (input) => store.sendMessage({ ...input, replyTo: documentReplyTo }),
})

async function onSendDocument(document: ComposerDocument, mentionUserIds: number[], mentionAll: boolean, signal: AbortSignal): Promise<void> {
  documentReplyTo = replyTo.value
  const replyRoomKey = store.state.currentRoom ? roomKeyString(store.state.currentRoom) : null
  replyTo.value = null
  uploading.value = true
  try {
    await sendDocument(document, mentionUserIds, mentionAll, signal)
  } catch {
    // 中止是用户主动放弃，引用条保持清空；房间已切换也不恢复（documentReplyTo 指向旧房间，塞回新房间会发错 replyMessageId）
    if (!signal.aborted && store.state.currentRoom && roomKeyString(store.state.currentRoom) === replyRoomKey) {
      replyTo.value = documentReplyTo
    }
  } finally {
    uploading.value = false
    documentReplyTo = null
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
      replyTo: replyTo.value,
      attachment: {
        ...uploaded,
        kind: 'voice',
        durationMs: recording.durationMs,
        waveform: recording.waveform,
      },
    })
    replyTo.value = null
  } finally {
    uploading.value = false
  }
}


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
      :contacts="contacts.filter((contact) => contact.id !== store.state.myUserId)"
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
      :is-dm="isDm"
      :audience-size="audienceSize"
      :read-receipts="store.state.readReceipts"
      :can-manage="activeRoom?.kind !== 'dm' && (store.state.channels.find((channel) => channel.id === activeRoom?.id)?.canManage ?? false)"
      :just-sent-ids="store.justSentIds.value"
      :member-map="chatMemberMap"
      :load-error="roomsError"
      :group-error="groupCreationError"
      @select="onSelect"
      @open-dm="onOpenDm"
      @back="onBack"
      @load-earlier="onLoadEarlier"
      @show-receipts="onShowReceipts"
      @visible-read="onVisibleRead"
      @enter-done="store.enterDone"
      @delete="onDeleteMessage"
      @quote="replyTo = $event"
      @mention="onMention"
      @forward="onForward"
      @create-group="onCreateGroup"
      @open-group-details="onOpenGroupDetails"
    >
      <template #composer>
        <Composer
          v-if="store.state.currentRoom"
          ref="composerView"
          :key="contextKey"
          :context-key="contextKey"
          :disabled="store.state.realtimeStatus === 'error'"
          :sending="store.state.sending"
          :uploading="uploading"
          :reply-to="replyTo"
          :contacts="contacts"
          :can-mention-all="activeRoom?.kind !== 'dm' && (store.state.channels.find((channel) => channel.id === activeRoom?.id)?.myRole === 'owner')"
          @send="onSend"
          :submit-document="onSendDocument"
          @send-voice="onSendVoice"
          @cancel-reply="replyTo = null"
        />
      </template>
    </ChatLayout>

    <!-- #220 已读名单浮层：Teleport 到 body；关闭路径（Esc/遮罩/钮）在浮层组件内 -->
    <ReadReceipts
      v-if="handshakeReady"
      :open="receiptsOpen"
      :summary="receiptTarget ? store.state.readReceipts[receiptTarget.id] ?? null : null"
      :audience-size="audienceSize"
      :room-name="store.state.roomName"
      :member-map="chatMemberMap"
      :exclude-user-id="receiptTarget?.sender.id"
      @close="closeReceipts"
    />

    <GroupDetails
      v-if="groupDetailsOpen && activeRoom && activeRoom.kind !== 'dm'"
      :name="activeRoom.name"
      :members="groupMembers"
      :contacts="contacts"
      :can-manage="store.state.channels.find((channel) => channel.id === activeRoom?.id)?.canManage ?? false"
      :busy="groupDetailsBusy"
      :error="groupDetailsError"
      @close="groupDetailsOpen = false"
      @invite="onInviteMembers"
    />

    <!-- #347 转发目标弹窗：群组（已加入频道）+ 联系人（确认时 openDm 解析 dm 房间） -->
    <ForwardDialog
      :open="forwardOpen"
      :mode="forwardState?.mode ?? 'single'"
      :count="forwardState?.messageIds.length ?? 0"
      :channels="store.state.channels"
      :contacts="contacts.filter((contact) => contact.id !== store.state.myUserId)"
      :busy="forwardBusy"
      :error="forwardError"
      @close="onForwardClose"
      @confirm="onForwardConfirm"
    />

    <div v-if="!handshakeError && !handshakeReady" class="chat-root-boot" data-test="handshaking" aria-busy="true">
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
