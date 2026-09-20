// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatApi, type ChatApi } from '../src/lib/api'
import { createChatStore } from '../src/lib/chat-store'
import { buildMockWorld, createMockChatApi } from '../src/lib/mock-api'
import type { Message, WsMessageFrame } from '../src/lib/types'

/**
 * #235：live 传输层回归。
 * 病灶：api.ts live openRoomSocket 把 event.data（JSON 字符串）原样上抛，
 * store 判型恒 false → 实时消息/回执/控制帧全部静默丢弃（mock 自行解析，CI 全绿掩盖）。
 * 这里用 fake WebSocket 注入「字符串帧」驱动 live socket 实现，断言：
 *   ① 解析面：字符串帧 → 解析成对象才交上层（坏帧静默丢弃）；
 *   ② 集成面：解析后的帧驱动 store 实时入列/回执递增（不重开房间）；
 *   ③ 自消息竞态：WS 回显先于 REST 回包 → 仍上屏，REST 回包幂等去重。
 */

/** 本文件专用消息工厂（mock 世界形状）。 */
const baseMessage = (over: Partial<Message> = {}): Message => ({
  id: 11,
  content: '你好',
  mentionUserIds: [],
  mentions: [],
  createdAt: '2026-09-16T09:07:00',
  source: 'local',
  sender: { kind: 'local', id: 2, username: 'xiaolin', displayName: '小林', avatarUrl: '', source: 'local' },
  attachment: null,
  ...over,
})

/** 不落盘的 storage 替身（同 read-receipts.test.ts 内联实现）。 */
function createChatStorageInert(): import('../src/lib/storage').ChatStorage {
  const memory = new Map<string, string>()
  return {
    get: (key) => memory.get(key) ?? null,
    set: (key, value) => void memory.set(key, value),
    remove: (key) => void memory.delete(key),
    getJSON<T>(key: string, fallback: T): T {
      const raw = memory.get(key)
      if (raw === undefined || raw === null) return fallback
      try {
        return JSON.parse(raw) as T
      } catch {
        return fallback
      }
    },
    setJSON: (key, value) => void memory.set(key, JSON.stringify(value)),
  }
}

type Listener = (event: { data?: unknown }) => void

/** 最小 fake WebSocket：记录 listener，测试手动 pump 字符串帧与状态。 */
function installFakeSocket() {
  const listeners = new Map<string, Set<Listener>>()
  const sent: string[] = []
  const emit = (type: string, event: { data?: unknown } = {}) => {
    for (const listener of listeners.get(type) ?? []) listener(event)
  }
  let captured: { readyState: number; url: string } | null = null
  class FakeWebSocket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 0
    url: string
    constructor(url: string) {
      this.url = url
      captured = this
    }
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    }
    send(text: string) {
      sent.push(text)
    }
    close() {}
  }
  vi.stubGlobal('WebSocket', FakeWebSocket)
  return {
    pump: (text: string) => emit('message', { data: text }),
    status: (status: 'open' | 'closed' | 'error') => emit(status),
    instance: () => captured,
    sent,
  }
}

/** mock REST 面 + live socket 面（正好复现 live 实况：REST 历史拉取 + WS 字符串帧推送）。 */
function hybridApi(liveOpen: ChatApi['openRoomSocket'], overrides: Partial<ChatApi> = {}): ChatApi {
  return { ...(createMockChatApi(buildMockWorld()) as ChatApi), openRoomSocket: liveOpen, ...overrides }
}

describe('#235 解析面：live 字符串帧 → JSON.parse 后交上层；坏帧静默丢弃', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('同参契约：live 实现收字符串帧，解析失败零回调；合法帧回调对象（onMessage 入参=对象）', () => {
    const fake = installFakeSocket()
    const onMessage = vi.fn()
    const onStatus = vi.fn()
    const handle = createChatApi({ getToken: () => 'tok' }).openRoomSocket({
      kind: 'public',
      roomId: 1,
      token: 'tok',
      onMessage,
      onStatus,
    })
    fake.pump('{not-json')
    fake.pump('42')
    fake.pump('null')
    expect(onMessage).not.toHaveBeenCalled()
    expect(onStatus).not.toHaveBeenCalledWith('error')
    const frame = { protocolVersion: 1, type: 'ready' }
    fake.pump(JSON.stringify(frame))
    expect(onMessage).toHaveBeenCalledWith(frame)
    // 控制帧上行通道完好（#220/#51 控制帧换绑）
    fake.instance()!.readyState = 1
    handle.send?.('{"type":"token_refresh","token":"t2"}')
    expect(fake.sent).toEqual(['{"type":"token_refresh","token":"t2"}'])
  })
})

describe('#235 集成面：解析后帧驱动 store（实时入列/回执递增，不重开房间）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('ready/open + 建连 URL 带 token；ready 帧置 open', async () => {
    const fake = installFakeSocket()
    const liveOpen = createChatApi({ getToken: () => 'tok' }).openRoomSocket
    const store = createChatStore({
      api: hybridApi(liveOpen),
      storage: createChatStorageInert(),
      myUserId: () => 1,
      getToken: () => 'tok',
    })
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    expect(fake.instance()?.url).toContain('/api/ws/public/1?token=tok')
    fake.status('open')
    fake.pump(JSON.stringify({ protocolVersion: 1, type: 'ready' }))
    expect(store.state.realtimeStatus).toBe('open')
    store.closeSockets()
  })

  it('他人消息字符串帧 → 实时入列 + 自动已读上报（病灶现场：此前静默丢弃）', async () => {
    const fake = installFakeSocket()
    const liveOpen = createChatApi({ getToken: () => 'tok' }).openRoomSocket
    const reportMessagesRead = vi.fn()
    const store = createChatStore({
      api: hybridApi(liveOpen, { reportMessagesRead }),
      storage: createChatStorageInert(),
      myUserId: () => 1,
      getToken: () => 'tok',
    })
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    const before = store.state.messages.length
    const incoming = baseMessage({ id: 900 })
    fake.pump(JSON.stringify({ protocolVersion: 1, type: 'message', message: incoming } satisfies WsMessageFrame))
    await Promise.resolve()
    expect(store.state.messages.map((m) => m.id)).toContain(900)
    expect(store.state.messages.length).toBe(before + 1)
    expect(reportMessagesRead).toHaveBeenCalled()
    store.closeSockets()
  })

  it('他人已读回执字符串帧 → readReceipts 面递增（实时回执递增，不重开房间）', async () => {
    const fake = installFakeSocket()
    const liveOpen = createChatApi({ getToken: () => 'tok' }).openRoomSocket
    const store = createChatStore({
      api: hybridApi(liveOpen),
      storage: createChatStorageInert(),
      myUserId: () => 1,
      getToken: () => 'tok',
    })
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    store.receiveRoomFrame({
      protocolVersion: 1,
      type: 'message',
      message: baseMessage({ id: 400, sender: { kind: 'local', id: 1, username: 'zhang', displayName: '张三', avatarUrl: '', source: 'local' } }),
    })
    fake.pump(
      JSON.stringify({
        protocolVersion: 1,
        type: 'read_receipts',
        userId: 2,
        room: { kind: 'public', id: 1 },
        messageIds: [400],
        readAt: '2026-09-16T10:00:00.000Z',
      }),
    )
    expect(store.state.readReceipts[400]?.count).toBe(1)
    expect(store.state.readReceipts[400]?.readBy[0]?.userId).toBe(2)
    store.closeSockets()
  })
})

describe('#235 自消息竞态：WS 回显先于 REST 回包 → 仍上屏（按 id 幂等）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('回显分支也入列：WS 回显先到 → 气泡即时出现；REST 回包后到被幂等去重（零重复）', async () => {
    const api = createMockChatApi(buildMockWorld())
    const store = createChatStore({
      api,
      storage: createChatStorageInert(),
      myUserId: () => 1,
      getToken: () => 'tok',
    })
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    const before = store.state.messages.length
    // live 实测时序：WS 回显（sender=本人）先于 REST 回包到达
    const echoMessage = baseMessage({
      id: 777,
      sender: { kind: 'local', id: 1, username: 'zhang', displayName: '张三', avatarUrl: '', source: 'local' },
    })
    store.receiveRoomFrame({ protocolVersion: 1, type: 'message', message: echoMessage })
    expect(store.state.messages.map((m) => m.id)).toContain(777)
    expect(store.state.messages.length).toBe(before + 1)
    expect(store.state.messages.filter((m) => m.id === 777).length).toBe(1)
    // REST 回包后到（重写 sendMessage 回同 id 消息，created=true）→ 幂等去重零重复
    ;(api as { sendMessage: unknown }).sendMessage = async () => ({ created: true, message: echoMessage })
    await store.sendMessage({ content: '回执请确认' })
    expect(store.state.messages.length).toBe(before + 1)
    store.closeSockets()
  })
})
