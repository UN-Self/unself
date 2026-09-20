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
import type {
  Channel,
  Dm,
  Message,
  MessagesPage,
  ReadReceiptsSummary,
  RoomFrame,
  RoomKind,
  UserSummary,
  WsRoomMessageNotice,
} from './types'
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
  /** 逐条已读回执（#220）：消息 id → 摘要（气泡回执面与名单浮层的唯一真值）。 */
  readReceipts: Record<number, ReadReceiptsSummary>
  /** 房间实时连接状态投影。 */
  realtimeStatus: ChatStoreInternals['realtimeStatus']
  /** 当前用户 id（token claims 解出 / mock 注入）。
   * #229 重定义：这是 core 用户 id（claims.sub / mock 主角 id），仅用于 mock 主角判定；
   * 与 chat 消息 sender.id（chat 内部 users.id）分属两个身份空间，禁直接比较。
   * chat 侧本人判定一律走 myUserId（core:sub → chat id 映射，见下）。
   */
  coreUserId: number
  /** 本人 chat 内部 id（#229）：由 coreUserId 经 contacts（username=core:<sub>）解析；
   * 未握手/联系人未就绪时为 0（不误判），载入或续期后自动重算。
   */
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
  /** 可见性上报（#220）：过滤已上报与本人消息后批量 POST；失败不伤状态，可随下次可见重试。 */
  recordVisibleRead(messageIds: number[]): Promise<void>
  /** 参照实现（#220）：把一批消息作为「本人已见」上报（视图层入口，测试盯请求面）。 */
  sendReadReport(messages: Message[]): Promise<void>
  /** token 静默续期换新后由会话层调用：向房间 socket 发 token_refresh 控制帧（决策 #51）。 */
  refreshSocketToken(token: string): void
  /** #229：重算本人身份（握手/续期/contacts 载入后调用；coreUserId+contacts 就绪即生效）。 */
  refreshMyUserId(): void
  /** 接收一帧收件箱通知。 */
  receiveInboxFrame(frame: WsRoomMessageNotice): void
  /** 关闭实时连接（卸载时）。 */
  closeSockets(): void
  /** 上传附件并返回引用（composer 调用）。 */
  uploadFile(file: File): Promise<Message['attachment']>
  /** reactive 状态源：组件/接线读动态字段一律走这里（顶层摊平仅数组引用兼容旧测试）。 */
  readonly state: ChatStoreInternals
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
  /** core 用户 id（#229：仅 mock 主角判定；勿与 sender.id 比较——身份空间不同）。 */
  coreUserId: number
  /** 本人 chat 内部 id（core:sub → contacts 解析；未就绪=0）。 */
  myUserId: number
  readReceipts: Record<number, ReadReceiptsSummary>
}

export interface CreateChatStoreOptions {
  api: ChatApi
  storage: ChatStorage
  /** 当前 core 用户 id（握手 token claims.sub 解出，或 mock 注入）。#229 起仅为 mock 主角判定/身份空间源。 */
  myUserId: () => number
  /** 已就绪 token（socket 建连用）。 */
  getToken: () => string | null
}

const HISTORY_PAGE_SIZE = 30

/** 创建聊天状态中枢（工厂注入边界替身，测试多实例互不干扰）。 */
export function createChatStore(options: CreateChatStoreOptions): ChatStore {
  const { api, storage, myUserId: coreUserId, getToken } = options

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
    coreUserId: 0,
    myUserId: 0,
    readReceipts: {},
  })

  /** 房间 socket 句柄（close 必备，send 为可选控制帧上行——#220 token_refresh）。 */
  let roomSocket: { close(): void; send?(text: string): void } | null = null
  let inboxSocket: { close(): void } | null = null
  /** 已知最早消息 id（历史分页游标）。 */
  let oldestMessageId = Number.POSITIVE_INFINITY
  /** 首页是否已加载过（loadOlder 的门槛）。 */
  let homeLoaded = false
  /** 已见消息 id（WS 广播 vs REST 回包 去重）。 */
  const seenMessageIds = new Set<number>()
  /** 已成功上报已读的消息 id（#220 幂等去重：同消息在会话内只报一次）。 */
  const reportedReadIds = new Set<number>()
  /** 本人发出的消息 id（上报跳过——发件人恒已读，不计回执）。 */
  const mySentMessageIds = new Set<number>()

  /**
   * #229 本人身份解析：claims.sub（core id）→ chat 内部 users.id。
   * 上游 JIT 建档（#217）用 username=`core:<sub>` 保证幂等，这里反向解析；
   * mock 模式无 core 命名空间，直接用主角 id。未就绪保持 0（不误判，宁可不判 mine）。
   */
  const resolveMyUserId = (): number => {
    const coreId = coreUserId()
    if (!coreId) return 0
    const contacts = state.contacts
    // 联系人未载入（含测试替身/mock 早期）：身份空间视为同构，直接透出 core id（旧行为兼容）；
    // 若世界里有 core: 命名空间（live JIT 用户），必须精确映射，禁止同构假设
    if (contacts.length === 0) return coreId
    if (contacts.some((u) => u.username.startsWith('core:'))) {
      return contacts.find((u) => u.username === `core:${coreId}`)?.id ?? 0
    }
    // mock 世界（无 core: 命名空间）：身份空间同构，按 id 对上
    return contacts.find((u) => u.id === coreId)?.id ?? 0
  }

  /** 解析结果重算（身份两个来源就绪后调用：contacts 载入/握手/续期）。 */
  const refreshMyUserId = (): void => {
    state.coreUserId = coreUserId()
    const next = resolveMyUserId()
    if (next === state.myUserId) return
    state.myUserId = next
    // 身份到位后重扫本房消息：迟到消息（此前无法判定 mine）补登记，
    // 并把「非本人」可见消息纳入上报（含此前被误判为本人而跳过的）
    for (const message of state.messages) {
      if (message.sender.id === state.myUserId) mySentMessageIds.add(message.id)
    }
  }

  const rememberMessage = (message: Message): boolean => {
    if (seenMessageIds.has(message.id)) return false
    seenMessageIds.add(message.id)
    return true
  }

  /** 记录单条消息的回执摘要（#220）：有则覆盖，无则不动（旧格式兼容）。 */
  const rememberReceipts = (message: Message): void => {
    if (!message.readReceipts) return
    state.readReceipts[message.id] = message.readReceipts
  }

  /** 逐条合并他人已读（#220）：已读过该消息的用户不重复计数/不重复名单。 */
  const applyReceiptFromUser = (messageId: number, userId: number, readAt: string): void => {
    const summary = state.readReceipts[messageId]
    if (summary && summary.readBy.some((r) => r.userId === userId)) return
    if (summary) {
      summary.count += 1
      summary.readBy.push({ userId, username: '', displayName: '', readAt })
      return
    }
    state.readReceipts[messageId] = { count: 1, readBy: [{ userId, username: '', displayName: '', readAt }] }
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
    if (message.sender.id === state.myUserId) mySentMessageIds.add(message.id)
    state.messages.push(message)
    oldestMessageId = Math.min(oldestMessageId, message.id)
  }

  const store: ChatStore = {
    ...state,

    state,

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
      // #229：联系人就绪后重算本人 chat id（core:sub → id 映射此时才可解析）
      refreshMyUserId()
    },

    openRoom: async (room, displayName) => {
      roomSocket?.close()
      roomSocket = null
      state.currentRoom = room
      state.roomName = displayName
      state.messages = []
      seenMessageIds.clear()
      state.readReceipts = {}
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
          for (const message of page.messages) {
            rememberMessage(message)
            rememberReceipts(message)
          }
          state.messages = [...page.messages]
          oldestMessageId = page.messages.length
            ? Math.min(...page.messages.map((m) => m.id))
            : Number.POSITIVE_INFINITY
          homeLoaded = true
          state.hasMoreHistory = page.messages.length >= HISTORY_PAGE_SIZE
          state.loadingHistory = 'ready'
          clearUnread(room)
          // 首页就绪即对可见消息做一次已读上报（链路 2 ③；失败静默，滚回可见再触发）
          void store.recordVisibleRead(page.messages.filter((m) => m.sender.id !== state.myUserId).map((m) => m.id))
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
          for (const message of fresh) rememberReceipts(message)
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
          // 本人消息（#235 竞态修复）：WS 回显可能先于 REST 回包，也走幂等入列——
          // handleMessage 按 id 去重，REST 回包后到会被 seenMessageIds 挡住，零重复；
          // 旧实现只登记不入列 → 回显先到时本人气泡不上屏（回执到了气泡却没到）
          handleMessage(message)
          rememberReceipts(message)
          return
        }
        handleMessage(message)
        // 他人新消息到达即视为可见（当前在房内）：立即上报已读（链路 2 ③）
        void store.recordVisibleRead([message.id])
        return
      }
      // #220 他人已读回执推送：只更新当前房间的摘要；本人帧忽略（上报者本人不需要被告知）
      if (frame.type === 'read_receipts') {
        if (frame.userId === state.myUserId) return
        if (!state.currentRoom) return
        for (const messageId of frame.messageIds) applyReceiptFromUser(messageId, frame.userId, frame.readAt)
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

    recordVisibleRead: async (messageIds) => {
      const room = state.currentRoom
      if (!room || messageIds.length === 0) return
      const pending = messageIds.filter(
        (id) => !reportedReadIds.has(id) && !mySentMessageIds.has(id),
      )
      if (pending.length === 0) return
      try {
        await api.reportMessagesRead(room.kind, room.id, pending)
      } catch {
        return // 上报失败不伤本地状态；未入 Set，下次可见即自动重试
      }
      for (const id of pending) {
        reportedReadIds.add(id)
        mySentMessageIds.add(id) // 服务端不分发本人上报，防御本地重发（无需再试）
      }
    },

    sendReadReport: (messages) => store.recordVisibleRead(messages.map((m) => m.id)),

    refreshSocketToken: (token) => {
      // 决策 #51：静默续期拿到新 token 后经房间 socket 发控制帧换绑（DO 回 token_refreshed ack）。
      // token 未就绪（握手前）不会被调用；socket 未开/句柄无 send（测试替身）时静默忽略，
      // 断线重连自带新 token（openRoomSocket 每次 openRoom 都取 getToken() 最新值）。
      roomSocket?.send?.(JSON.stringify({ type: 'token_refresh', token }))
    },

    /** #229：身份重算入口（握手后/续期后/contacts 载入后由调用方触发）。 */
    refreshMyUserId: () => refreshMyUserId(),
  }

  // #229：不再一次性求值 myUserId（旧实现在握手前同步执行，live 下 token 未就绪 → 恒 0）。
  // 初始化时先求一次（mock/测试同构场景立即生效）；live 的真实到位分两步：
  // 握手后 coreUserId 可解（App bootstrap 调 refreshMyUserId），contacts 载入后 chat id 可映射
  //（loadContacts 内再调一次）。两段都就绪前保持 0（不误判 mine）。
  state.coreUserId = coreUserId()
  refreshMyUserId()

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
  return openInbox(api, token, store)
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
