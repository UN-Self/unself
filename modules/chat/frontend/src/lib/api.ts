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
  Dm,
  Message,
  MessagesPage,
  OpenDmResult,
  RoomKind,
  UserSummary,
} from './types'

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

const LIVE_BASE = '/api'

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
      response = await fetch(`${LIVE_BASE}${path}`, init)
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
  getMessages(kind: RoomKind, roomId: number, before?: number | null): Promise<MessagesPage>
  sendMessage(input: {
    kind: RoomKind
    roomId: number
    content: string
    clientMessageId: string
    attachment?: Attachment | null
    mentionUserIds?: number[]
  }): Promise<{ created: boolean; message: Message }>
  uploadFile(file: File): Promise<{ file: Attachment }>
  /** WS 建连回调形态：测试传内存 socket，live 走 URL。 */
  openRoomSocket(handlers: {
    kind: RoomKind
    roomId: number
    token: string
    onMessage: (frame: unknown) => void
    onStatus: (status: 'connecting' | 'open' | 'closed' | 'error') => void
  }): { close(): void }
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
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
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
      return (await response.json()) as { file: Attachment }
    })
  const openRoomSocket =
    options.openRoomSocket ??
    ((handlers: Parameters<ChatApi['openRoomSocket']>[0]) => {
      // live：`/api/ws/:kind/:id?token=`（上游 WEBSOCKET_AUTH：会话先经 worker 校验再升级）；
      // 浏览器 WebSocket 不能带 Authorization 头，token 走查询串是上游协议契约。
      const wsProtocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${wsProtocol}//${globalThis.location.host}/api/ws/${handlers.kind}/${handlers.roomId}?token=${encodeURIComponent(handlers.token)}`
      let socket: WebSocket | null = null
      try {
        socket = new WebSocket(url)
      } catch {
        handlers.onStatus('error')
        return { close() {} }
      }
      socket.addEventListener('open', () => handlers.onStatus('open'))
      socket.addEventListener('close', () => handlers.onStatus('closed'))
      socket.addEventListener('error', () => handlers.onStatus('error'))
      socket.addEventListener('message', (event) => handlers.onMessage(event.data))
      return {
        close() {
          socket?.close()
        },
      }
    })

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
    listChannels: () => get<{ channels: Channel[] }>('/channels'),
    listContacts: () => get<{ users: UserSummary[] }>('/contacts'),
    listDms: () => get<{ dms: Dm[] }>('/dm'),
    openDm: (userId) => postJson<OpenDmResult>('/dm/open', { userId }),
    joinChannel: (channelId) => postJson<{ ok: true }>(`/channels/${channelId}/join`, {}),
    getMessages: (kind, roomId, before) =>
      get<MessagesPage>(`/messages${query({ kind, roomId, before: before ?? undefined })}`),
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
      }),
    uploadFile,
    openRoomSocket,
  }
}
