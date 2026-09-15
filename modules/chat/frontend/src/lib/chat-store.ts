// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 聊天状态中枢（#218）：唯一的消息列表真值、会话列表、实时连接与未读投影。
 * 组件只调用 store 方法 / 读 store 状态；API 与 socket 打开器经依赖注入，
 * 行为测试用内存实现驱动（docs/testing.md：替身只出现在外部边界）。
 *
 * 实时语义（上游 ChannelRoom/UserInbox 行为规格参照）：
 * - 房间 socket：ready 帧 → 已连通；message 帧且非本人 → 尾插消息；
 * - 收件箱 room_message 帧 → 未进房会话累加未读/@未读（在房内则忽略）；
 * - 发送走 REST 幂等端点（clientMessageId 去重回显），socket 只收广播不承担提交。
 */
import { reactive } from 'vue'
import type { Channel, Dm, Message, MessagesPage, RoomFrame, RoomKind, UserSummary, WsRoomMessageNotice } from './types'
import type { ChatApi } from './api'
import type { ChatStorage } from './storage'

export type LoadState = 'loading' | 'ready' | 'error'

export interface RoomKey {
  kind: RoomKind
  id: number
}

export function roomKeyString(key: RoomKey): string {
  return `${key.kind}:${key.id}`
}

export interface SendMessageInput {
  content: string
  attachment?: Message['attachment']
  mentionUserIds?: number[]
}

export interface ChatStore {
  /** 当前会话（null = 列表态/窄屏回列表）。 */
  currentRoom: RoomKey | null
  roomName: string
  messages: Message[]
  /** 历史是否还有更早一页（分页终止条件：整页 <30 条）。 */
  hasMoreHistory: boolean
  loadingHistory: LoadState
  historyError: string
  sending: boolean
  sendError: string
  channels: Channel[]
  channelsState: LoadState
  dms: Dm[]
  dmsState: LoadState
  contacts: UserSummary[]
  /** 房间实时连接状态投影。 */
  realtimeStatus: ChatStoreInternals['realtimeStatus']
  /** 当前用户 id（token claims 解出 / mock 注入）。 */
  myUserId: number

  loadChannels(): Promise<void>
  loadDms(): Promise<void>
  loadContacts(): Promise<void>
  /** 打开会话：拉历史 + 清未读 + 记忆偏好 + 建房 socket。 */
  openRoom(room: RoomKey, displayName: string): Promise<void>
  /** 加载更早历史（滚轮上翻触发）；无更早或正在加载时是空操作。 */
  loadOlderMessages(): Promise<void>
  /** 幂等发送：REST 提交（clientMessageId），失败置 sendError 并上抛。 */
  sendMessage(input: SendMessageInput): Promise<void>
  /** 接收一帧房间消息（live 由 socket 回调驱动；测试直呼注入）。 */
  receiveRoomFrame(frame: RoomFrame): void
  /** 接收一帧收件箱通知。 */
  receiveInboxFrame(frame: WsRoomMessageNotice): void
  /** 关闭实时连接（卸载时）。 */
  closeSockets(): void
  /** 上传附件并返回引用（composer 调用）。 */
  uploadFile(file: File): Promise<Message['attachment']>
}

/** 内部 reactive 形状（store 原样暴露）。 */
export interface ChatStoreInternals {
  currentRoom: RoomKey | null
  roomName: string
  messages: Message[]
  hasMoreHistory: boolean
  loadingHistory: LoadState
  historyError: string
  sending: boolean
  sendError: string
  channels: Channel[]
  channelsState: LoadState
  dms: Dm[]
  dmsState: LoadState
  contacts: UserSummary[]
  realtimeStatus: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error'
  myUserId: number
}

export interface CreateChatStoreOptions {
  api: ChatApi
  storage: ChatStorage
  /** 当前用户 id（握手 token claims 解出，或 mock 注入）。 */
  myUserId: () => number
  /** 已就绪 token（socket 建连用）。 */
  getToken: () => string | null
}

const HISTORY_PAGE_SIZE = 30

/** 创建聊天状态中枢（工厂注入边界替身，测试多实例互不干扰）。 */
export function createChatStore(options: CreateChatStoreOptions): ChatStore {
  const { api, storage, myUserId, getToken } = options

  const state = reactive<ChatStoreInternals>({
    currentRoom: null,
    roomName: '',
    messages: [],
    hasMoreHistory: true,
    loadingHistory: 'loading',
    historyError: '',
    sending: false,
    sendError: '',
    channels: [],
    channelsState: 'loading',
    dms: [],
    dmsState: 'loading',
    contacts: [],
    realtimeStatus: 'idle',
    myUserId: 0,
  })

  let roomSocket: { close(): void } | null = null
  let inboxSocket: { close(): void } | null = null
  /** 已知最早消息 id（历史分页游标）。 */
  let oldestMessageId = Number.POSITIVE_INFINITY
  /** 首页是否已加载过（loadOlder 的门槛）。 */
  let homeLoaded = false
  /** 已见消息 id（WS 广播 vs REST 回包 去重）。 */
  const seenMessageIds = new Set<number>()

  const rememberMessage = (message: Message): boolean => {
    if (seenMessageIds.has(message.id)) return false
    seenMessageIds.add(message.id)
    return true
  }

  const findRoomList = (room: RoomKey): { unreadCount: number; mentionUnreadCount: number } | null => {
    if (room.kind === 'dm') return state.dms.find((d) => d.id === room.id) ?? null
    return state.channels.find((c) => c.id === room.id) ?? null
  }

  const clearUnread = (room: RoomKey): void => {
    const entry = findRoomList(room)
    if (entry) {
      entry.unreadCount = 0
      entry.mentionUnreadCount = 0
    }
  }

  const handleMessage = (message: Message): void => {
    if (!rememberMessage(message)) return
    state.messages.push(message)
    oldestMessageId = Math.min(oldestMessageId, message.id)
  }

  const store: ChatStore = {
    ...state,

    loadChannels: async () => {
      state.channelsState = 'loading'
      try {
        const result = await api.listChannels()
        state.channels = result.channels
        state.channelsState = 'ready'
      } catch (error) {
        state.channelsState = 'error'
        state.historyError = error instanceof Error ? error.message : String(error)
      }
    },

    loadDms: async () => {
      state.dmsState = 'loading'
      try {
        const result = await api.listDms()
        state.dms = result.dms
        state.dmsState = 'ready'
      } catch {
        state.dmsState = 'error'
      }
    },

    loadContacts: async () => {
      const result = await api.listContacts()
      state.contacts = result.users
    },

    openRoom: async (room, displayName) => {
      roomSocket?.close()
      roomSocket = null
      state.currentRoom = room
      state.roomName = displayName
      state.messages = []
      seenMessageIds.clear()
      oldestMessageId = Number.POSITIVE_INFINITY
      homeLoaded = false
      state.hasMoreHistory = true
      state.historyError = ''
      state.loadingHistory = 'loading'
      // 记忆最后打开的会话（界面偏好；无凭证落库）
      storage.setJSON('last-room', room)
      try {
        const page: MessagesPage = await api.getMessages(room.kind, room.id)
        // 焦点已切走的迟到回包：丢弃（防串房）
        if (state.currentRoom && roomKeyString(state.currentRoom) === roomKeyString(room)) {
          for (const message of page.messages) rememberMessage(message)
          state.messages = [...page.messages]
          oldestMessageId = page.messages.length
            ? Math.min(...page.messages.map((m) => m.id))
            : Number.POSITIVE_INFINITY
          homeLoaded = true
          state.hasMoreHistory = page.messages.length >= HISTORY_PAGE_SIZE
          state.loadingHistory = 'ready'
          clearUnread(room)
        }
      } catch (error) {
        state.loadingHistory = 'error'
        state.historyError = error instanceof Error ? error.message : String(error)
        return
      }
      // 历史就绪后开实时；token 未就绪显式标记错误（不发无凭证连接）
      const token = getToken()
      if (!token) {
        state.realtimeStatus = 'error'
        return
      }
      state.realtimeStatus = 'connecting'
      roomSocket = api.openRoomSocket({
        kind: room.kind,
        roomId: room.id,
        token,
        onStatus: (status) => {
          if (status === 'open') state.realtimeStatus = 'open'
          else if (status === 'connecting') state.realtimeStatus = 'connecting'
          else if (status === 'error') state.realtimeStatus = 'error'
          else state.realtimeStatus = 'closed'
        },
        onMessage: (frame) => store.receiveRoomFrame(frame as RoomFrame),
      })
    },

    loadOlderMessages: async () => {
      const room = state.currentRoom
      if (!room || !homeLoaded || !state.hasMoreHistory || state.loadingHistory === 'loading') return
      const before = Number.isFinite(oldestMessageId) ? oldestMessageId : null
      if (before === null) {
        state.hasMoreHistory = false
        return
      }
      state.loadingHistory = 'loading'
      try {
        const page = await api.getMessages(room.kind, room.id, before)
        if (state.currentRoom && roomKeyString(state.currentRoom) === roomKeyString(room)) {
          const fresh = page.messages.filter((m) => rememberMessage(m))
          state.messages.unshift(...fresh)
          if (fresh.length) oldestMessageId = Math.min(oldestMessageId, ...fresh.map((m) => m.id))
          state.hasMoreHistory = page.messages.length >= HISTORY_PAGE_SIZE
          state.loadingHistory = 'ready'
        }
      } catch (error) {
        state.loadingHistory = 'error'
        state.historyError = error instanceof Error ? error.message : String(error)
      }
    },

    sendMessage: async (input) => {
      const room = state.currentRoom
      if (!room || state.sending) return
      state.sending = true
      state.sendError = ''
      try {
        const clientMessageId =
          globalThis.crypto?.randomUUID?.() ?? `cm-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const result = await api.sendMessage({
          kind: room.kind,
          roomId: room.id,
          content: input.content,
          clientMessageId,
          attachment: input.attachment ?? null,
          mentionUserIds: input.mentionUserIds ?? [],
        })
        // created=false = 服务端幂等回显（重试场景）：不重复插入
        if (result.created) handleMessage(result.message)
      } catch (error) {
        state.sendError = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        state.sending = false
      }
    },

    receiveRoomFrame: (frame) => {
      if (frame.type === 'ready') {
        state.realtimeStatus = 'open'
        return
      }
      if (frame.type === 'error') {
        state.realtimeStatus = 'error'
        state.sendError = frame.error
        return
      }
      if (frame.type === 'message') {
        const message = frame.message
        if (message.sender.id === state.myUserId) {
          // 本人消息：REST 回包已插入，这里只登记去重（WS 广播回显）
          rememberMessage(message)
          return
        }
        handleMessage(message)
      }
    },

    receiveInboxFrame: (frame) => {
      const room = { kind: frame.room.kind, id: frame.room.id }
      // 正在房内：消息会经房间 socket 到达，这里不再计未读
      if (state.currentRoom && roomKeyString(state.currentRoom) === roomKeyString(room)) return
      const entry = findRoomList(room)
      if (!entry) return
      entry.unreadCount += 1
      if (frame.mentionsMe) entry.mentionUnreadCount += 1
    },

    closeSockets: () => {
      roomSocket?.close()
      roomSocket = null
      inboxSocket?.close()
      inboxSocket = null
      state.realtimeStatus = 'closed'
    },

    uploadFile: (file) => api.uploadFile(file).then((r) => r.file),
  }

  state.myUserId = myUserId()
  // 收件箱 socket 由壳侧/根组件装配（此处只暴露注入点）
  void inboxSocket
  return store
}

/** 装配收件箱实时：房间帧交 store，room_message 帧交未读投影。返回关闭句柄。 */
export function attachInboxSocket(
  store: ChatStore,
  api: ChatApi,
  getToken: () => string | null,
): { close(): void } | null {
  const token = getToken()
  if (!token) return null
  return api.openRoomSocket === api.openRoomSocket
    ? openInbox(api, token, store)
    : null
}

function openInbox(api: ChatApi, token: string, store: ChatStore): { close(): void } {
  // 收件箱与房间共用 /api/ws/:kind/:id 面；上游有独立 /api/inbox/ws，
  // 本阶段前端先挂 general 频道的房间连接充当全屋广播（#216 未定 inbox 端点，缺口已记录回报）。
  const handle = api.openRoomSocket({
    kind: 'public',
    roomId: 1,
    token,
    onStatus: () => {},
    onMessage: (frame) => {
      const parsed = frame as WsRoomMessageNotice | { type: string }
      if ((parsed as WsRoomMessageNotice).type === 'room_message') {
        store.receiveInboxFrame(parsed as WsRoomMessageNotice)
      } else if ((parsed as { type: string; message?: unknown }).type === 'message') {
        // 房间广播帧在收件箱挂载点也会到达：交给 store 的去重通道
        store.receiveRoomFrame(parsed as RoomFrame)
      }
    },
  })
  return handle
}
