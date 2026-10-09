// SPDX-License-Identifier: AGPL-3.0-only

/**
 * chat 后端 API 客户端（#218）：请求面 = 上游 worker 的 REST 端点
 * （api.js 调用顺序参照、响应形状 = worker/src/api/*.js 出参；零代码拷贝）。
 *
 * 认证：Authorization: Bearer <模块 token>——token 由 SDK 握手/静默续期供给，
 * 只存内存（§6.5 权限只信服务端会话）；localStorage 绝不落 token。
 *
 * 双实现：live（fetch 到部署的 worker，#216）与 mock（内存数据源，#216 未部署时
 * 行为走查/联调用），由 createChatApi 的 transport 参数切换；组件只依赖 ChatApi 接口。
 */
import type {
  Attachment,
  Channel,
  ChannelMember,
  Dm,
  Message,
  MessagesPage,
  OpenDmResult,
  RoomKind,
  UserSummary,
} from './types'
import { openReconnectableSocket } from './reconnectable-socket'

/** 上游错误信封：{ error: string }（errorResponse），JSON 解析失败时无信封。 */
export interface ChatApiError extends Error {
  status: number
}

export function makeChatApiError(status: number, message: string): ChatApiError {
  const err = new Error(message) as ChatApiError
  err.status = status
  return err
}

/** 网络传输抽象：live = fetch('/api' 相对同源)，mock = 内存路由。 */
export type Transport = (path: string, init: RequestInit) => Promise<Response>

/**
 * 模块可能运行在自有 workers.dev 根路径，也可能被壳挂在同域 `/m/<id>/`。
 * 同域 iframe 中 location.host 仍是壳域名，因此 API/WS 必须保留挂载前缀；
 * 直接请求 `/api` 会落到 workbench，返回「not found」。
 */
export function liveModuleMount(pathname: string): string {
  const match = pathname.match(/^(\/m\/[^/]+)(?:\/|$)/)
  return match?.[1] ?? ''
}

export function liveApiBase(pathname: string): string {
  return `${liveModuleMount(pathname)}/api`
}

/** Worker 返回的文件路径以模块根为基准；壳挂载时补上 /m/<module> 前缀。 */
export function moduleFileUrl(pathname: string, url: string): string {
  if (!url.startsWith('/files/')) return url
  return `${liveModuleMount(pathname)}${url}`
}

function normalizeAttachment(pathname: string, attachment: Attachment | null): Attachment | null {
  if (!attachment) return null
  return { ...attachment, url: moduleFileUrl(pathname, attachment.url) }
}

function normalizeMessage(pathname: string, message: Message): Message {
  return { ...message, attachment: normalizeAttachment(pathname, message.attachment) }
}

function normalizeSocketFrame(pathname: string, frame: Record<string, unknown>): Record<string, unknown> {
  if (frame.type === 'message' && frame.message && typeof frame.message === 'object') {
    return { ...frame, message: normalizeMessage(pathname, frame.message as Message) }
  }
  return frame
}

/** Bearer 头装配；token 未就绪时显式失败（不发无凭证请求）。 */
export function authHeaders(token: string | null): Record<string, string> {
  if (!token) {
    throw makeChatApiError(0, '模块令牌未就绪，请稍候重试')
  }
  return { authorization: `Bearer ${token}` }
}

/** live transport：同源 `/api/*` + Bearer；{error} 信封 → ChatApiError。 */
export function createLiveTransport(): Transport {
  return async (path, init) => {
    let response: Response
    try {
      response = await fetch(`${liveApiBase(globalThis.location.pathname)}${path}`, init)
    } catch {
      throw makeChatApiError(0, '网络不可用，请检查连接后重试')
    }
    if (!response.ok) {
      throw await toChatApiError(response)
    }
    return response
  }
}

/** 统一错误解析：优先服务端 error 人话（上游信封即字符串），解析失败用状态码兜底。 */
export async function toChatApiError(response: Response): Promise<ChatApiError> {
  let message = `请求失败（${response.status}）`
  try {
    const payload: unknown = await response.json()
    const serverMessage = (
      payload as { error?: unknown } | null
    )?.error
    if (typeof serverMessage === 'string' && serverMessage.trim()) {
      message = serverMessage
    }
  } catch {
    // body 非 JSON：保留状态码兜底文案
  }
  return makeChatApiError(response.status, message)
}

export interface ChatApi {
  listChannels(): Promise<{ channels: Channel[] }>
  listContacts(): Promise<{ users: UserSummary[] }>
  listDms(): Promise<{ dms: Dm[] }>
  openDm(userId: number): Promise<OpenDmResult>
  joinChannel(channelId: number): Promise<{ ok: true }>
  createChannel(input: { name: string; description?: string; kind?: 'public' | 'private'; memberUserIds: number[] }): Promise<{ channel: Channel }>
  listChannelMembers(channelId: number): Promise<{ members: ChannelMember[] }>
  inviteChannelMembers(channelId: number, userIds: number[]): Promise<{ members: ChannelMember[] }>
  getMessages(kind: RoomKind, roomId: number, before?: number | null): Promise<MessagesPage>
  /** 已读上报（#220）：HTTP 批量端点，幂等；空数组不发请求。 */
  reportMessagesRead(kind: RoomKind, roomId: number, messageIds: number[]): Promise<void>
  sendMessage(input: {
    kind: RoomKind
    roomId: number
    content: string
    clientMessageId: string
    attachment?: Attachment | null
    mentionUserIds?: number[]
  }): Promise<{ created: boolean; message: Message }>
  uploadFile(file: File): Promise<{ file: Attachment }>
  /** WS 建连回调形态：测试传内存 socket，live 走 URL。返回句柄含可选 send（控制帧上行，#220）。 */
  openRoomSocket(handlers: {
    kind: RoomKind
    roomId: number
    token: string
    onMessage: (frame: unknown) => void
    onStatus: (status: 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error') => void
  }): { close(): void; send?(text: string): void }
  openInboxSocket(handlers: {
    token: string
    onMessage: (frame: unknown) => void
    onStatus: (status: 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error') => void
  }): { close(): void; send?(text: string): void }
}

export interface CreateChatApiOptions {
  /** live/mock 切换（#216 部署后默认 live）。 */
  transport?: Transport
  /** 当前模块 token（内存态，SDK 续期后由调用方换新）。 */
  getToken: () => string | null
  /** 文件上传实现（mock 与 live 差异大，注入便于测试/进度）。 */
  upload?: (file: File) => Promise<{ file: Attachment }>
  /** room socket 打开器（注入内存实现用于测试/mock）。 */
  openRoomSocket?: ChatApi['openRoomSocket']
  openInboxSocket?: ChatApi['openInboxSocket']
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

/**
 * WS 文本帧解析（#235）：event.data（字符串）→ 对象。
 * 返回 undefined = 不可用帧（非 JSON / 非对象如 `42`/`null`），调用方静默丢弃。
 * mock（mock-api）与 live 共用同一入参契约：上层 onMessage 只见已解析对象。
 */
export function parseSocketFrame(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 组装 chat API（依赖注入 transport/token/socket；行为对齐上游调用面）。 */
export function createChatApi(options: CreateChatApiOptions): ChatApi {
  const transport = options.transport ?? createLiveTransport()
  const uploadFile =
    options.upload ??
    (async (file: File) => {
      const token = options.getToken()
      const body = new FormData()
      body.append('file', file)
      const response = await transport('/upload', {
        method: 'POST',
        headers: authHeaders(token),
        body,
      })
      const result = (await response.json()) as { file: Attachment }
      return { file: { ...result.file, url: moduleFileUrl(globalThis.location.pathname, result.file.url) } }
    })
  const openRoomSocket =
    options.openRoomSocket ??
    ((handlers: Parameters<ChatApi['openRoomSocket']>[0]) => openReconnectableSocket({
      getToken: options.getToken,
      connect: (token, connection) => {
      // live：`/api/ws/:kind/:id?token=`（上游 WEBSOCKET_AUTH：会话先经 worker 校验再升级）；
      // 浏览器 WebSocket 不能带 Authorization 头，token 走查询串是上游协议契约。
      const wsProtocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${wsProtocol}//${globalThis.location.host}${liveApiBase(globalThis.location.pathname)}/ws/${handlers.kind}/${handlers.roomId}?token=${encodeURIComponent(token)}`
      let socket: WebSocket | null = null
      try { socket = new WebSocket(url) } catch { connection.onStatus('error'); return { close() {} } }
      socket.addEventListener('open', () => connection.onStatus('open'))
      socket.addEventListener('close', () => connection.onStatus('closed'))
      socket.addEventListener('error', () => connection.onStatus('error'))
      socket.addEventListener('message', (event) => {
        // #235：浏览器文本帧 event.data = JSON 字符串，必须先解析再上抛——
        // onMessage 契约恒收对象（与 mock 实现同参，store 按对象判型）；
        // 非 JSON 或非对象帧（心跳/二进制等）静默丢弃，不污染上层状态机
        const frame = parseSocketFrame(event.data)
        if (frame !== undefined) connection.onMessage(normalizeSocketFrame(globalThis.location.pathname, frame))
      })
      return {
        close() {
          socket?.close()
        },
        // #220 token 续期控制帧上行（决策 #51：控制帧换绑，不重连不断流）
        send(text: string) {
          if (socket && socket.readyState === WebSocket.OPEN) socket.send(text)
        },
      }
      },
      onMessage: handlers.onMessage,
      onStatus: handlers.onStatus,
    }))
  const openInboxSocket =
    options.openInboxSocket ??
    ((handlers: Parameters<ChatApi['openInboxSocket']>[0]) => openReconnectableSocket({
      getToken: options.getToken,
      connect: (token, connection) => {
      const wsProtocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${wsProtocol}//${globalThis.location.host}${liveApiBase(globalThis.location.pathname)}/inbox/ws?token=${encodeURIComponent(token)}`
      let socket: WebSocket | null = null
      try { socket = new WebSocket(url) } catch { connection.onStatus('error'); return { close() {} } }
      socket.addEventListener('open', () => connection.onStatus('open'))
      socket.addEventListener('close', () => connection.onStatus('closed'))
      socket.addEventListener('error', () => connection.onStatus('error'))
      socket.addEventListener('message', (event) => {
        const frame = parseSocketFrame(event.data)
        if (frame !== undefined) connection.onMessage(normalizeSocketFrame(globalThis.location.pathname, frame))
      })
      return { close() { socket?.close() }, send(text: string) { if (socket?.readyState === WebSocket.OPEN) socket.send(text) } }
      },
      onMessage: handlers.onMessage,
      onStatus: handlers.onStatus,
    }))

  const requestJson = async <T,>(path: string, init: RequestInit): Promise<T> => {
    const response = await transport(path, init)
    return (await response.json()) as T
  }

  const get = <T,>(path: string) => requestJson<T>(path, { headers: authHeaders(options.getToken()) })
  const postJson = <T,>(path: string, body: unknown) =>
    requestJson<T>(path, {
      method: 'POST',
      headers: { ...authHeaders(options.getToken()), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  return {
    listChannels: async () => {
      const result = await get<{ channels: Channel[] }>('/channels')
      return result
    },
    listContacts: async () => {
      const result = await get<{ users: UserSummary[] }>('/contacts')
      return { users: result.users.map((user) => ({ ...user, avatarUrl: moduleFileUrl(globalThis.location.pathname, user.avatarUrl) })) }
    },
    listDms: async () => {
      const result = await get<{ dms: Dm[] }>('/dm')
      return { dms: result.dms.map((dm) => ({ ...dm, otherUser: { ...dm.otherUser, avatarUrl: moduleFileUrl(globalThis.location.pathname, dm.otherUser.avatarUrl) } })) }
    },
    openDm: async (userId) => {
      const result = await postJson<OpenDmResult>('/dm/open', { userId })
      return { dm: { ...result.dm, otherUser: { ...result.dm.otherUser, avatarUrl: moduleFileUrl(globalThis.location.pathname, result.dm.otherUser.avatarUrl) } } }
    },
    joinChannel: (channelId) => postJson<{ ok: true }>(`/channels/${channelId}/join`, {}),
    createChannel: (input) => postJson<{ channel: Channel }>('/channels', input),
    listChannelMembers: async (channelId) => {
      const result = await get<{ members: ChannelMember[] }>(`/channels/${channelId}/members`)
      return { members: result.members.map((member) => ({ ...member, avatarUrl: moduleFileUrl(globalThis.location.pathname, member.avatarUrl) })) }
    },
    inviteChannelMembers: (channelId, userIds) => postJson<{ members: ChannelMember[] }>(`/channels/${channelId}/invite`, { userIds }),
    getMessages: async (kind, roomId, before) => {
      const result = await get<MessagesPage>(`/messages${query({ kind, roomId, before: before ?? undefined })}`)
      return { ...result, messages: result.messages.map((message) => normalizeMessage(globalThis.location.pathname, message)) }
    },
    // #220 已读上报走 HTTP（决策：回执批量/幂等语义在 REST 端点闭环，socket 只收广播）
    reportMessagesRead: async (kind, roomId, messageIds) => {
      const deduped = [...new Set(messageIds)]
      if (deduped.length === 0) return
      await postJson('/messages/read', { kind, roomId, messageIds: deduped })
    },
    sendMessage: (input) =>
      requestJson<{ created: boolean; message: Message }>(`/v1/rooms/${input.kind}/${input.roomId}/messages`, {
        method: 'POST',
        headers: { ...authHeaders(options.getToken()), 'content-type': 'application/json' },
        body: JSON.stringify({
          clientMessageId: input.clientMessageId,
          content: input.content,
          attachment: input.attachment ?? null,
          mentionUserIds: input.mentionUserIds ?? [],
        }),
      }).then((result) => ({ ...result, message: normalizeMessage(globalThis.location.pathname, result.message) })),
    uploadFile,
    openRoomSocket,
    openInboxSocket,
  }
}
