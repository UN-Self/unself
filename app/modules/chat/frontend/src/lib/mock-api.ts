// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 内存 mock API（#218）：#216 worker 未部署时的行为走查/联调数据源。
 * 形状严格对齐 worker/src/api/*.js 出参（types.ts 契约）；不做智能，只求「像」：
 * 列表/分页/发送/上传/WS 广播语义与上游一致，数据存内存、刷新即重置。
 */
import type {
  Attachment,
  Channel,
  Dm,
  ForwardBundleEntry,
  Message,
  ReadReceiptBy,
  ReadReceiptsSummary,
  RoomKind,
  UserSummary,
} from './types'
import type { ChatApi } from './api'
import { replaceMentionNames, textMentionsName } from './mention-text'

/** mock 消息内存行（内部形态，出参转 Message 契约）。 */
interface MockMessageRow extends Message {
  roomId: number
}

export interface MockWorld {
  me: UserSummary
  channels: Channel[]
  dms: Dm[]
  contacts: UserSummary[]
  messagesByRoom: Map<string, MockMessageRow[]>
}

/** 构造走查世界：general/-random 频道 + 与 小林 的私聊 + 若干历史消息（含@/文件/语音）。 */
export function buildMockWorld(): MockWorld {
  const me: UserSummary = { id: 1, username: 'zhang', displayName: '张三', avatarUrl: '' }
  const xiaolin: UserSummary = { id: 2, username: 'xiaolin', displayName: '小林', avatarUrl: '' }
  const laowang: UserSummary = { id: 3, username: 'laowang', displayName: '老王', avatarUrl: '' }
  const contacts: UserSummary[] = [me, xiaolin, laowang]

  const channels: Channel[] = [
    {
      id: 1,
      name: 'general',
      description: '团队公共频道',
      kind: 'public',
      isGeneral: true,
      ownerDisplayName: '张三',
      isMember: true,
      myRole: 'owner',
      canManage: true,
      memberCount: 3,
      lastMessageAt: '2026-09-15 09:30:00',
      unreadCount: 0,
      mentionUnreadCount: 0,
      mentionAllUnreadCount: 0,
    },
    {
      id: 2,
      name: 'random',
      description: '闲聊灌水',
      kind: 'public',
      isGeneral: false,
      ownerDisplayName: '小林',
      isMember: true,
      myRole: 'member',
      canManage: false,
      memberCount: 2,
      lastMessageAt: '2026-09-15 10:00:00',
      unreadCount: 2,
      mentionUnreadCount: 1,
      // 现成 @all 红标样例：首屏即可走查 [@全体成员]（与 [有人@我] 并存）
      mentionAllUnreadCount: 1,
    },
    {
      id: 3,
      name: '运营专属',
      description: '私有频道（未加入，可申请加入）',
      kind: 'private',
      isGeneral: false,
      ownerDisplayName: '老王',
      isMember: false,
      myRole: '',
      canManage: false,
      memberCount: 1,
      lastMessageAt: null,
      unreadCount: 0,
      mentionUnreadCount: 0,
      mentionAllUnreadCount: 0,
    },
  ]

  const dms: Dm[] = [
    {
      id: 101,
      kind: 'dm',
      name: 'dm:1:2',
      lastMessageAt: '2026-09-15 11:00:00',
      unreadCount: 0,
      mentionUnreadCount: 0,
      otherUser: xiaolin,
      isBlockedByMe: false,
    },
  ]

  const messagesByRoom = new Map<string, MockMessageRow[]>()
  const put = (kind: RoomKind, roomId: number, rows: MockMessageRow[]) => {
    messagesByRoom.set(`${kind}:${roomId}`, rows)
  }

  const mk = (over: Partial<MockMessageRow> & { id: number; content: string }): MockMessageRow => ({
    roomId: 1,
    mentionUserIds: [],
    mentions: [],
    createdAt: '2026-09-15 09:00:00',
    source: 'edgechat',
    sender: xiaolin as unknown as MockMessageRow['sender'],
    attachment: null,
    ...over,
  })

  /** 回执摘要快捷构造（mock 数据面；发件人恒已读口径 = readBy 不含发件人）。 */
  const receipts = (count: number, readBy: ReadReceiptBy[]): ReadReceiptsSummary => ({ count, readBy })
  const r = (userId: number, who: UserSummary, readAt: string): ReadReceiptBy => ({
    userId,
    username: who.username,
    displayName: who.displayName,
    readAt,
  })

  put('public', 1, [
    mk({
      id: 3,
      content: '早上好，今天发布窗口开着。',
      roomId: 1,
      createdAt: '2026-09-15 09:30:00',
      // 发小林的消息：老王已读（memberCount=3 含发件人，可达收件人=2）
      readReceipts: receipts(1, [r(3, laowang, '2026-09-15 09:31:00')]),
    }),
    mk({
      id: 2,
      content: '@张三 部署手册我放到附件了。',
      roomId: 1,
      createdAt: '2026-09-15 09:20:00',
      mentionUserIds: [1],
      mentions: [{ userId: 1, username: 'zhang', displayName: '张三' }],
      attachment: {
        key: 'chat/mock/deploy-guide.pdf',
        name: 'deploy-guide.pdf',
        type: 'application/pdf',
        size: 204800,
        url: '#mock-file',
      },
      readReceipts: receipts(1, [r(3, laowang, '2026-09-15 09:25:00')]),
    }),
    mk({
      id: 1,
      content: '收到，下午对齐。',
      roomId: 1,
      createdAt: '2026-09-15 09:10:00',
      sender: me as unknown as MockMessageRow['sender'],
      // 我发的消息：小林已读（老王没读过）→ 气泡「已读 1/2」
      readReceipts: receipts(1, [r(2, xiaolin, '2026-09-15 09:15:00')]),
    }),
  ])

  put('public', 2, [
    mk({
      id: 12,
      content: '@张三 这条是 @ 提醒红点走查消息。',
      roomId: 2,
      createdAt: '2026-09-15 10:00:00',
      mentionUserIds: [1],
      mentions: [{ userId: 1, username: 'zhang', displayName: '张三' }],
      readReceipts: receipts(0, []),
    }),
    mk({ id: 11, content: '周五团建报名接龙～', roomId: 2, createdAt: '2026-09-15 09:50:00', readReceipts: receipts(0, []) }),
  ])

  const voiceAttachment: Attachment = {
    key: 'chat/mock/voice-1.webm',
    name: 'voice-1.webm',
    type: 'audio/webm',
    size: 48000,
    url: '#mock-voice',
    kind: 'voice',
    durationMs: 9_400,
    waveform: [8, 22, 46, 60, 38, 90, 72, 30, 55, 20, 12, 66, 40, 18, 9],
  }
  put('dm', 101, [
    mk({
      id: 102,
      content: '',
      roomId: 101,
      createdAt: '2026-09-15 11:00:00',
      attachment: voiceAttachment,
      // 小林发的语音：我已读（DM 可达收件人=1，全读）
      readReceipts: receipts(1, [r(1, me, '2026-09-15 11:01:00')]),
    }),
    mk({
      id: 101,
      content: '在吗？对一下接口形状。',
      roomId: 101,
      createdAt: '2026-09-15 10:40:00',
      readReceipts: receipts(1, [r(1, me, '2026-09-15 10:45:00')]),
    }),
  ])

  return { me, channels, dms, contacts, messagesByRoom }
}

/** room socket 的 mock 句柄：测试/走查用它向客户端推帧、读客户端上行帧。 */
export interface MockRoomSocket {
  /** 服务端视角推送一帧（前端按 WS 帧解析处理）。 */
  serverPush(frame: unknown): void
  handlers: Parameters<ChatApi['openRoomSocket']>[0]
  closed: boolean
  /** 客户端上行帧记录（#220：token_refresh 控制帧的断言面）。 */
  outbox: string[]
}

/** 创建 mock 版 ChatApi：数据/广播全部在内存世界内闭环。 */
export function createMockChatApi(
  world: MockWorld = buildMockWorld(),
): ChatApi & { world: MockWorld; lastSocket: MockRoomSocket | null } {
  let nextMessageId = 10_000
  const api = {} as ChatApi & { world: MockWorld; lastSocket: MockRoomSocket | null }

  const rowToMessage = (row: MockMessageRow): Message => {
    const { roomId: _roomId, ...message } = row
    return message
  }

  const listRoom = (kind: RoomKind, roomId: number): MockMessageRow[] => {
    const rows = world.messagesByRoom.get(`${kind}:${roomId}`)
    if (!rows) throw Object.assign(new Error('会话不存在'), { status: 404 })
    return rows
  }

  const roomRef = (kind: RoomKind, roomId: number) => {
    if (kind === 'dm') {
      const dm = world.dms.find((d) => d.id === roomId)
      if (!dm) throw Object.assign(new Error('会话不存在'), { status: 404 })
      return { id: dm.id, kind, name: dm.name }
    }
    const channel = world.channels.find((c) => c.id === roomId)
    if (!channel) throw Object.assign(new Error('会话不存在'), { status: 404 })
    return { id: channel.id, kind, name: channel.name }
  }

  api.world = world
  api.lastSocket = null
  api.listChannels = async () => ({ channels: world.channels })
  api.listContacts = async () => ({ users: world.contacts })
  api.listDms = async () => ({ dms: world.dms })

  /** 全库按 id 找源消息（转发源可以是任何当前用户可见的房间；mock 不做房间授权细分）。 */
  const findMessageAnywhere = (messageId: number): MockMessageRow | null => {
    for (const rows of world.messagesByRoom.values()) {
      const row = rows.find((item) => item.id === messageId)
      if (row) return row
    }
    return null
  }

  /** 落地一条消息到目标房间（转发副本：本人发送、不带提及；外观与普通消息一致）。 */
  const insertForwardCopy = (input: Parameters<ChatApi['sendMessage']>[0], over: Partial<MockMessageRow>): MockMessageRow => ({
    id: ++nextMessageId,
    content: '',
    mentionUserIds: [],
    mentions: [],
    createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    // 与 worker 同口径：转发副本 source='forward'（触发器豁免标记 + 审计可辨识；外观不标注）
    source: 'forward',
    sender: {
      kind: 'local',
      id: world.me.id,
      username: world.me.username,
      displayName: world.me.displayName,
      avatarUrl: world.me.avatarUrl,
      source: 'edgechat',
    },
    attachment: null,
    roomId: input.roomId,
    ...over,
  })

  /** 目标房间正是当前连着的房间时按 WS 语义补推帧（对齐真实 DO 全量广播）。 */
  const pushIfCurrentRoom = (kind: RoomKind, roomId: number, messages: Message[]): void => {
    const socket = api.lastSocket
    if (!socket || socket.closed) return
    if (socket.handlers.kind !== kind || socket.handlers.roomId !== roomId) return
    for (const message of messages) {
      socket.serverPush({ protocolVersion: 1, type: 'message', message })
    }
  }

  /** @token 重写（#347 反馈②）：副本不带 mentions，正文 `@username` 重写为 `@displayName`（mention-text 共享口径）。 */
  const displayContentOf = (row: MockMessageRow): string => replaceMentionNames(row.content, row.mentions)
  const displayBlocksOf = (row: MockMessageRow): Message['blocks'] | null =>
    row.blocks
      ? row.blocks.map((block) => (block.type === 'text' ? { type: 'text', text: replaceMentionNames(block.text, row.mentions) } : block))
      : null
  /** 引用快照（#347 反馈③，与 worker replySnapshotOf 同语义）。 */
  const replySnapshotOf = (row: MockMessageRow): ForwardBundleEntry['reply'] => {
    const reply = row.replyTo
    if (!reply) return null
    if (reply.deleted || !('content' in reply)) return { deleted: true, authorName: '', text: '' }
    return { deleted: false, authorName: reply.sender?.displayName ?? '', text: reply.content || reply.attachment?.name || '' }
  }

  // mock 只撑 UI 演示：不做房间授权/DM 拉黑细分，不复刻 worker 的幂等回显与并发兜底
  const mockForward = (input: Parameters<ChatApi['sendMessage']>[0]): { created: boolean; message: Message } => {
    const targetRows = listRoom(input.kind, input.roomId)
    const sources = input.forward!.messageIds.map(findMessageAnywhere)
    if (sources.some((row) => row === null || row.deleted)) {
      throw Object.assign(new Error('转发的消息不存在或已被删除'), { status: 400 })
    }
    // 按源消息 id 升序（旧→新）落地与展示，与 worker 同口径
    const sourceRows = (sources as MockMessageRow[]).sort((left, right) => left.id - right.id)
    if (input.forward!.mode === 'merged') {
      const bundle: MockMessageRow = insertForwardCopy(input, {
        content: `[聊天记录] ${sourceRows.length} 条消息`,
        blocks: [{
          type: 'forward_bundle',
          count: sourceRows.length,
          messages: sourceRows.map((row) => ({
            content: displayContentOf(row),
            blocks: displayBlocksOf(row) ?? null,
            attachment: row.attachment ?? null,
            senderName: row.sender.displayName,
            createdAt: row.createdAt,
            reply: replySnapshotOf(row),
          })),
        }],
        clientMessageId: input.clientMessageId,
      })
      targetRows.unshift(bundle)
      const created = rowToMessage(bundle)
      pushIfCurrentRoom(input.kind, input.roomId, [created])
      return { created: true, message: created }
    }
    // 逐条：每条源消息复制为一条普通消息（幂等键按序派生；@token 重写为显示名）
    const createdMessages = sourceRows.map((row, index) => {
      const createdRow = insertForwardCopy(input, {
        content: displayContentOf(row),
        blocks: displayBlocksOf(row) ?? undefined,
        attachment: row.attachment ?? null,
        clientMessageId: `${input.clientMessageId}-${index + 1}`,
      })
      targetRows.unshift(createdRow)
      return rowToMessage(createdRow)
    })
    pushIfCurrentRoom(input.kind, input.roomId, createdMessages)
    return { created: true, message: createdMessages.at(-1)! }
  }

  api.openDm = async (userId) => {
    const existing = world.dms.find((d) => d.otherUser.id === userId)
    if (existing) return { dm: existing }
    const other = world.contacts.find((u) => u.id === userId)
    if (!other) throw Object.assign(new Error('目标用户不存在'), { status: 404 })
    const dm: Dm = {
      id: 100 + other.id,
      kind: 'dm',
      name: `dm:${world.me.id}:${other.id}`,
      lastMessageAt: null,
      unreadCount: 0,
      mentionUnreadCount: 0,
      otherUser: other,
      isBlockedByMe: false,
    }
    world.dms.push(dm)
    return { dm }
  }

  api.joinChannel = async (channelId) => {
    const channel = world.channels.find((c) => c.id === channelId)
    if (!channel || channel.kind !== 'public') {
      throw Object.assign(new Error('公开群组不存在'), { status: 404 })
    }
    channel.isMember = true
    return { ok: true as const }
  }

  api.createChannel = async (input) => {
    const id = Math.max(0, ...world.channels.map((channel) => channel.id)) + 1
    const channel: Channel = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      kind: input.kind ?? 'private',
      isGeneral: false,
      ownerDisplayName: world.me.displayName,
      isMember: true,
      myRole: 'owner',
      canManage: true,
      memberCount: input.memberUserIds.length + 1,
      lastMessageAt: null,
      unreadCount: 0,
      mentionUnreadCount: 0,
    }
    world.channels.push(channel)
    world.messagesByRoom.set(`${channel.kind}:${channel.id}`, [])
    return { channel }
  }
  api.listChannelMembers = async (channelId) => {
    const channel = world.channels.find((item) => item.id === channelId)
    if (!channel) throw Object.assign(new Error('群组不存在'), { status: 404 })
    return { members: [world.me, ...world.contacts.filter((user) => user.id !== world.me.id).slice(0, Math.max(0, channel.memberCount - 1))].map((user) => ({ ...user, role: user.id === world.me.id ? 'owner' : 'member' })) }
  }
  api.inviteChannelMembers = async (channelId, userIds) => {
    const channel = world.channels.find((item) => item.id === channelId)
    if (!channel) throw Object.assign(new Error('群组不存在'), { status: 404 })
    channel.memberCount += userIds.length
    return api.listChannelMembers(channelId)
  }

  api.getMessages = async (kind, roomId, before) => {
    const rows = listRoom(kind, roomId)
    const filtered = before ? rows.filter((r) => r.id < before) : rows
    return {
      room: { ...roomRef(kind, roomId), description: null },
      messages: filtered.slice(0, 30).map(rowToMessage),
      pinnedMessage: null,
    }
  }

  api.sendMessage = async (input) => {
    const rows = listRoom(input.kind, input.roomId)
    // #347 转发：客户端只传源消息 id，服务端（mock 同语义）读取复制——逐条/合并
    if (input.forward && input.forward.messageIds.length > 0) {
      return mockForward(input)
    }
    // 幂等：同 clientMessageId 直接回显已存在消息（上游 idempotent 语义）
    const existing = rows.find((r) => r.clientMessageId === input.clientMessageId)
    if (existing) return { created: false, message: rowToMessage(existing) }
    const mentions = (input.mentionUserIds ?? [])
      .map((id) => world.contacts.find((u) => u.id === id))
      .filter((u): u is UserSummary => Boolean(u))
      .map((u) => ({ userId: u.id, username: u.username, displayName: u.displayName }))
    const created: MockMessageRow = {
      id: ++nextMessageId,
      content: input.content,
      mentionUserIds: input.mentionUserIds ?? [],
      mentions,
      createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      source: 'edgechat',
      sender: {
        kind: 'local',
        id: world.me.id,
        username: world.me.username,
        displayName: world.me.displayName,
        avatarUrl: world.me.avatarUrl,
        source: 'edgechat',
      },
      attachment: input.attachment ?? null,
      blocks: input.blocks,
      // @all（契约 4.1）：频道/群聊 + 群主（myRole=owner 口径，对齐 worker）+ 客户端 chip 标记
      // + 文本含边界包裹的 @所有人 才置位；手打不算（#347 定案）
      mentionAll:
        input.kind !== 'dm' &&
        input.mentionAll === true &&
        world.channels.find((c) => c.id === input.roomId)?.myRole === 'owner' &&
        textMentionsName(input.content, '所有人'),
      clientMessageId: input.clientMessageId,
      roomId: input.roomId,
    }
    // 引用（与 worker 同语义）：同房间存在即挂，已删除回 deleted 占位（见 worker messages.js 读路径）；mock 直接回填整条原消息（含发言人/内容）
    if (input.replyTo) {
      const replyRow = rows.find((r) => r.id === input.replyTo?.id && r.roomId === input.roomId)
      if (replyRow) {
        created.replyToMessageId = replyRow.id
        created.replyTo = replyRow.deleted ? { id: replyRow.id, deleted: true } : rowToMessage(replyRow)
      }
    }
    rows.unshift(created)
    return { created: true, message: rowToMessage(created) }
  }

  // #220 已读上报：内存生效（逐条幂等落行；成功后新读也广播 read_receipts，同真实 DO 语义）
  api.reportMessagesRead = async (kind, roomId, messageIds) => {
    const rows = listRoom(kind, roomId)
    const readAt = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const freshIds: number[] = []
    const cursor = Math.max(...new Set(messageIds))
    for (const row of rows.filter((item) => item.id <= cursor)) {
      if (row.sender.id === world.me.id) continue
      const id = row.id
      const summary = row.readReceipts ?? { count: 0, readBy: [] }
      if (summary.readBy.some((r) => r.userId === world.me.id)) continue
      summary.count += 1
      summary.readBy.push({
        userId: world.me.id,
        username: world.me.username,
        displayName: world.me.displayName,
        readAt,
      })
      row.readReceipts = summary
      freshIds.push(id)
    }
    // 与真实 DO 一致：有新增才广播；本人帧由 store 忽略，其他端可对齐
    if (freshIds.length > 0 && api.lastSocket && !api.lastSocket.closed) {
      api.lastSocket.serverPush({
        protocolVersion: 1,
        type: 'read_receipts',
        messageId: Math.max(...freshIds),
        userId: world.me.id,
        readAt,
        messageIds: freshIds,
      })
    }
  }
  api.deleteMessage = async (kind, roomId, messageId) => {
    const rows = world.messagesByRoom.get(`${kind}:${roomId}`) ?? []
    const message = rows.find((item) => item.id === messageId)
    if (!message) throw new Error('消息不存在或已被删除')
    message.deleted = true
    message.content = ''
    message.attachment = null
    message.blocks = undefined
    api.lastSocket?.serverPush({ protocolVersion: 1, type: 'message_deleted', messageId })
  }

  api.uploadFile = async (file: File) => {
    const attachment: Attachment = {
      key: `chat/mock/${Date.now()}-${file.name}`,
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      url: '#mock-upload',
    }
    return { file: attachment }
  }

  api.openRoomSocket = (handlers) => {
    const socket: MockRoomSocket = {
      handlers,
      serverPush: (frame) => {
        if (!socket.closed) handlers.onMessage(frame)
      },
      closed: false,
      outbox: [],
    }
    api.lastSocket = socket
    // 与真服务端一致：连上先发 ready 帧
    queueMicrotask(() => {
      handlers.onStatus('open')
      handlers.onMessage({ protocolVersion: 1, type: 'ready' })
    })
    return {
      close() {
        socket.closed = true
        handlers.onStatus('closed')
      },
      // #220：mock socket 不验 token，控制帧照收（outbox 记录供断言；回环给 onMessage 模拟 DO ack）
      send(text: string) {
        socket.outbox.push(text)
        try {
          handlers.onMessage(JSON.parse(text) as unknown)
        } catch {
          /* 非 JSON 帧静默丢弃（与真实 WS 行为一致：发出去即不管） */
        }
      },
    }
  }
  api.openInboxSocket = (handlers) => api.openRoomSocket({
    kind: 'public',
    roomId: 1,
    token: handlers.token,
    onStatus: handlers.onStatus,
    onMessage: handlers.onMessage,
  })

  return api
}
