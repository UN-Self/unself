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
  Message,
  RoomKind,
  UserSummary,
} from './types'
import type { ChatApi } from './api'

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

  put('public', 1, [
    mk({ id: 3, content: '早上好，今天发布窗口开着。', roomId: 1, createdAt: '2026-09-15 09:30:00' }),
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
    }),
    mk({
      id: 1,
      content: '收到，下午对齐。',
      roomId: 1,
      createdAt: '2026-09-15 09:10:00',
      sender: me as unknown as MockMessageRow['sender'],
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
    }),
    mk({ id: 11, content: '周五团建报名接龙～', roomId: 2, createdAt: '2026-09-15 09:50:00' }),
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
    }),
    mk({
      id: 101,
      content: '在吗？对一下接口形状。',
      roomId: 101,
      createdAt: '2026-09-15 10:40:00',
    }),
  ])

  return { me, channels, dms, contacts, messagesByRoom }
}

/** room socket 的 mock 句柄：测试/走查用它向客户端推帧。 */
export interface MockRoomSocket {
  /** 服务端视角推送一帧（前端按 WS 帧解析处理）。 */
  serverPush(frame: unknown): void
  handlers: Parameters<ChatApi['openRoomSocket']>[0]
  closed: boolean
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
      clientMessageId: input.clientMessageId,
      roomId: input.roomId,
    }
    rows.unshift(created)
    return { created: true, message: rowToMessage(created) }
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
    }
  }

  return api
}
