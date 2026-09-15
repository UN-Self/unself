// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 聊天领域类型（#218）：形状对齐上游 API（参照 aozorae/Edgechat @29978c2
 * worker/src/api/*.js 与 worker/src/data/*.js 的 JSON 出参；仅作行为规格参照，零代码拷贝）。
 * 后端未就绪（#216/#217 未合），live API 面按此契约开发 + mock 实现。
 */

/** 会话种类：公开频道 / 私有频道 / 私聊（上游 room kind 同款三值）。 */
export type RoomKind = 'public' | 'private' | 'dm'

/** 会话基础（频道与私聊共用，房间路由 kind:id）。 */
export interface RoomRef {
  id: number
  kind: RoomKind
  name: string
}

/** 频道（GET /api/channels 出参项，上游 mapVisibleChannel）。 */
export interface Channel {
  id: number
  name: string
  description: string
  kind: 'public' | 'private'
  isGeneral: boolean
  ownerDisplayName: string
  isMember: boolean
  myRole: string
  canManage: boolean
  memberCount: number
  lastMessageAt: string | null
  unreadCount: number
  mentionUnreadCount: number
}

/** 用户摘要（/api/contacts 出参项，上游 mapUserSummary）。 */
export interface UserSummary {
  id: number
  username: string
  displayName: string
  avatarUrl: string
}

/** 私聊会话（GET /api/dm 出参项，上游 mapUserDm）。 */
export interface Dm {
  id: number
  kind: 'dm'
  name: string
  lastMessageAt: string | null
  unreadCount: number
  mentionUnreadCount: number
  otherUser: UserSummary
  isBlockedByMe: boolean
}

/** 私聊开通结果（POST /api/dm/open 出参）。 */
export interface OpenDmResult {
  dm: Dm
}

/** 附件（消息内嵌；上游 mapAttachment / recordUploadedFile→file 出参）。 */
export interface Attachment {
  key: string
  name: string
  type: string
  size: number
  url: string
  /** 语音/音频附件标记（kind=voice 时前端渲染播放气泡）。 */
  kind?: 'voice' | 'audio'
  durationMs?: number
  /** 语音波形采样（0-100 归一化，上游 voice 附件持久化字段）。 */
  waveform?: number[]
}

/** 提及片段（渲染 @ 高亮用；上游 mapMessage.mentions）。 */
export interface Mention {
  userId: number
  username: string
  displayName: string
}

/** 发送者（本地用户；external/Telegram 桥上游已裁剪，前端仅处理 local 形状）。 */
export interface MessageSender {
  kind: 'local'
  id: number
  username: string
  displayName: string
  avatarUrl: string
  source: string
}

/** 消息（GET /api/messages 与 WS message 帧共用的形状）。 */
export interface Message {
  id: number
  content: string
  mentionUserIds: number[]
  mentions: Mention[]
  createdAt: string
  source: string
  sender: MessageSender
  attachment: Attachment | null
  /** 幂等发送的客户端 id（回显去重键，上游 clientMessageId）。 */
  clientMessageId?: string
  replyToMessageId?: number
  replyTo?: Message | { id: number; deleted: boolean }
}

/** GET /api/messages 出参（room + 当前页消息 + 置顶）。 */
export interface MessagesPage {
  room: RoomRef & { description: string | null }
  messages: Message[]
  pinnedMessage: Message | null
}

// ---- WS 实时帧（上游 ChannelRoom/UserInbox DO，protocolVersion: 1）----

export interface WsReadyFrame {
  protocolVersion: 1
  type: 'ready'
  room?: { id: number; kind: RoomKind; name: string }
}

export interface WsMessageFrame {
  protocolVersion: 1
  type: 'message'
  message: Message
}

export interface WsErrorFrame {
  protocolVersion: 1
  type: 'error'
  error: string
}

/** 收件箱通知帧（上游 unread-projection → UserInbox broadcast）。 */
export interface WsRoomMessageNotice {
  protocolVersion: 1
  type: 'room_message'
  room: { id: number; kind: RoomKind; name: string }
  messageId: number
  createdAt: string
  unreadCount: number
  mentionUnreadCount?: number
  mentionsMe: boolean
  replyToMe: boolean
  contentPreview: string
  sender: MessageSender
}

export type RoomFrame = WsReadyFrame | WsMessageFrame | WsErrorFrame
export type InboxFrame = { protocolVersion: 1; type: 'ready' } | WsRoomMessageNotice

/** WS 连接状态。 */
export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error'
