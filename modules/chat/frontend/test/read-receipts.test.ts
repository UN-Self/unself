// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import MessageBubble from '../src/components/MessageBubble.vue'
import ReadReceipts from '../src/components/ReadReceipts.vue'
import { createChatStore } from '../src/lib/chat-store'
import { buildMockWorld, createMockChatApi } from '../src/lib/mock-api'
import type { Message, ReadReceiptsSummary } from '../src/lib/types'

/**
 * 已读回执行为（#220，docs/testing.md 两问检验）：
 * - 气泡回执标签：DM 已读 ✓✓ / 群聊已读 n/m / 全读 / 未读 / 缺省不显示（旧格式兼容）
 * - store：openRoom 记录回执、read_receipts 帧更新（本人帧忽略/重复帧幂等/仅当前房）
 * - 可见性上报：openRoom 自动上报他人消息、去重（重复触发只发一次）、失败不伤状态可重试
 * - mock/api 契约：/messages/read 请求形状、空数组不发请求、getMessages 带回执
 * - session onTokenRenewed：续期换新触发回调、首 token 不触发
 * 断言全部打在用户可见结果（data-test 锚点/事件/请求面），零类名/DOM 结构断言。
 */

const baseMessage = (over: Partial<Message> = {}): Message => ({
  id: 11,
  content: '你好',
  mentionUserIds: [],
  mentions: [],
  createdAt: '2026-09-16T09:07:00',
  source: 'local',
  sender: { kind: 'local', id: 2, username: 'bob', displayName: '鲍勃', avatarUrl: '', source: 'local' },
  attachment: null,
  ...over,
})

const summary = (count: number, userIds: number[] = []): ReadReceiptsSummary => ({
  count,
  readBy: userIds.map((userId) => ({ userId, username: `u${userId}`, displayName: `用户${userId}`, readAt: '2026-09-16T10:00:00' })),
})

describe('气泡回执标签（#220）', () => {
  it('DM 已读：显示「已读 ✓✓」，aria 语义=对方已读；未读显示「未读」', () => {
    const read = mount(MessageBubble, {
      props: { message: baseMessage(), mine: true, isDm: true, audienceSize: 1, readSummary: summary(1, [3]) },
    })
    const tag = read.find('[data-test="bubble-receipt"]')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toContain('已读 ✓✓')
    expect(tag.attributes('aria-label')).toBe('对方已读')
    read.unmount()

    const unread = mount(MessageBubble, {
      props: { message: baseMessage(), mine: true, isDm: true, audienceSize: 1, readSummary: summary(0, []) },
    })
    expect(unread.find('[data-test="bubble-receipt"]').text()).toContain('未读')
    unread.unmount()
  })

  it('群聊部分已读：已读 n/m；全部已读：已读；零已读：未读', () => {
    const partial = mount(MessageBubble, {
      props: { message: baseMessage(), mine: true, audienceSize: 4, readSummary: summary(2, [3, 4]) },
    })
    expect(partial.find('[data-test="bubble-receipt"]').text()).toContain('已读 2/4')
    partial.unmount()

    const all = mount(MessageBubble, {
      props: { message: baseMessage(), mine: true, audienceSize: 2, readSummary: summary(2, [3, 4]) },
    })
    expect(all.find('[data-test="bubble-receipt"]').text()).toContain('已读')
    all.unmount()

    const none = mount(MessageBubble, {
      props: { message: baseMessage(), mine: true, audienceSize: 3, readSummary: summary(0, []) },
    })
    expect(none.find('[data-test="bubble-receipt"]').text()).toContain('未读')
    none.unmount()
  })

  it('缺省回执数据（旧格式）/对方消息：不显示回执面', () => {
    const legacy = mount(MessageBubble, { props: { message: baseMessage(), mine: true } })
    expect(legacy.find('[data-test="bubble-receipt"]').exists()).toBe(false)
    legacy.unmount()

    const theirs = mount(MessageBubble, {
      props: { message: baseMessage(), mine: false, audienceSize: 2, readSummary: summary(1, [3]) },
    })
    expect(theirs.find('[data-test="bubble-receipt"]').exists()).toBe(false)
    theirs.unmount()
  })

  it('点击标签 emit show-receipts（带消息本体）；浮层不在气泡内渲染', async () => {
    const message = baseMessage()
    const wrapper = mount(MessageBubble, {
      props: { message, mine: true, audienceSize: 2, readSummary: summary(1, [3]) },
    })
    await wrapper.find('[data-test="bubble-receipt"]').trigger('click')
    expect(wrapper.emitted('show-receipts')?.[0]).toEqual([message])
    expect(wrapper.find('[data-test="read-receipts-overlay"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('已读名单浮层（#220）', () => {
  it('open 时渲染名单：已读行（姓名+时间）与未读占位；关闭钮 close', async () => {
    const wrapper = mount(ReadReceipts, {
      props: { summary: summary(2, [2, 3]), audienceSize: 4, open: true, roomName: 'general' },
      attachTo: document.body,
    })
    await flushPromises()
    // Teleport 到 body：锚点从 document 全局找
    const overlay = document.querySelector('[data-test="read-receipts-overlay"]')
    expect(overlay).not.toBeNull()
    expect(document.querySelector('[data-test="receipt-title"]')?.textContent).toContain('general')
    expect(document.querySelectorAll('[data-test="receipt-row-read"]')).toHaveLength(2)
    expect(document.body.textContent).toContain('用户2')
    expect(document.body.textContent).toContain('10:00')
    expect(document.querySelector('[data-test="receipt-row-unread"]')?.textContent).toContain('未读 2 人')

    // Teleport 内容在 body 下（wrapper 树外）：直接 DOM 事件面触发点击
    document.querySelector<HTMLButtonElement>('[data-test="receipt-close"]')?.click()
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('open=false 不渲染浮层；Esc 关闭；点击遮罩关闭', async () => {
    const wrapper = mount(ReadReceipts, {
      props: { summary: summary(1, [2]), audienceSize: 2, open: false },
      attachTo: document.body,
    })
    await flushPromises()
    expect(document.querySelector('[data-test="read-receipts-overlay"]')).toBeNull()

    await wrapper.setProps({ open: true })
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)

    await wrapper.setProps({ open: true })
    await flushPromises()
    document.querySelector<HTMLElement>('[data-test="receipt-scrim"]')?.click()
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(2)
    wrapper.unmount()
  })
})

describe('store 回执状态与上报（#220）', () => {
  it('openRoom 自动上报首页他人消息（本人消息不报）；mock 世界内存生效', async () => {
    const api = createMockChatApi()
    const postSpy = vi.spyOn(api, 'reportMessagesRead')
    const store = createChatStore({
      api,
      storage: createChatStorageInert(),
      myUserId: () => api.world.me.id,
      getToken: () => 'mock-token',
    })
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    await flushPromises()
    // 首页他人消息 = id 3、2（id 1 是我发的，跳过）
    expect(postSpy).toHaveBeenCalledTimes(1)
    expect(postSpy.mock.calls[0]?.[2]).toEqual(expect.arrayContaining([2, 3]))
    expect(postSpy.mock.calls[0]?.[2]).not.toContain(1)
    // 上报在 mock 世界落行：我的名字进了 id 3 的已读名单
    const row = api.world.messagesByRoom.get('public:1')!.find((m) => m.id === 3)!
    expect(row.readReceipts?.readBy.some((r) => r.userId === api.world.me.id)).toBe(true)
    store.closeSockets()
  })

  it('read_receipts 帧更新回执摘要（已读数递增）；重复帧/本人帧幂等', async () => {
    const api = createMockChatApi(buildMockWorld())
    const store = createChatStore({
      api,
      storage: createChatStorageInert(),
      myUserId: () => 1,
      getToken: () => 'mock-token',
    })
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    await flushPromises()
    const baseline = store.state.readReceipts[3]?.count ?? 0

    // 他人（id 2）已读 → count +1
    store.receiveRoomFrame({
      protocolVersion: 1,
      type: 'read_receipts',
      messageId: 3,
      userId: 2,
      readAt: '2026-09-16T10:00:00',
      messageIds: [3, 2],
    })
    expect(store.state.readReceipts[3]?.count).toBe(baseline + 1)

    // 同一用户重复帧：不重复计数（幂等）
    store.receiveRoomFrame({
      protocolVersion: 1,
      type: 'read_receipts',
      messageId: 3,
      userId: 2,
      readAt: '2026-09-16T10:01:00',
      messageIds: [3],
    })
    expect(store.state.readReceipts[3]?.count).toBe(baseline + 1)

    // 本人帧（userId=1）：忽略
    store.receiveRoomFrame({
      protocolVersion: 1,
      type: 'read_receipts',
      messageId: 3,
      userId: 1,
      readAt: '2026-09-16T10:02:00',
      messageIds: [3],
    })
    expect(store.state.readReceipts[3]?.count).toBe(baseline + 1)
    store.closeSockets()
  })

  it('上报失败不影响 store 状态，下次可见可重试（不进已上报集合）', async () => {
    const api = createMockChatApi()
    let failing = true
    api.reportMessagesRead = vi.fn(async () => {
      if (failing) throw Object.assign(new Error('网络不可用'), { status: 0 })
    })
    const store = createChatStore({
      api,
      storage: createChatStorageInert(),
      myUserId: () => api.world.me.id,
      getToken: () => 'mock-token',
    })
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    await flushPromises()
    expect(store.state.loadingHistory).toBe('ready') // 失败不伤历史状态

    // 恢复网络后再次可见 → 重新上报同一批
    failing = false
    await store.recordVisibleRead([3, 2])
    expect(api.reportMessagesRead).toHaveBeenCalledTimes(2)
    store.closeSockets()
  })

  it('recordVisibleRead 去重：成功上报过的消息不再重发；空数组不发请求', async () => {
    const api = createMockChatApi()
    api.reportMessagesRead = vi.fn(async () => {})
    const store = createChatStore({
      api,
      storage: createChatStorageInert(),
      myUserId: () => api.world.me.id,
      getToken: () => 'mock-token',
    })
    await store.recordVisibleRead([])
    expect(api.reportMessagesRead).not.toHaveBeenCalled()

    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    await flushPromises()
    const firstCalls = vi.mocked(api.reportMessagesRead).mock.calls.length
    await store.recordVisibleRead([3, 2]) // openRoom 已报过的消息
    expect(vi.mocked(api.reportMessagesRead).mock.calls.length).toBe(firstCalls)
    store.closeSockets()
  })
})

describe('live api 契约（#220）', () => {
  it('空批次不发请求（transport 零调用）；非空批 POST /messages/read 带 dedupe 后数组', async () => {
    const { createChatApi } = await import('../src/lib/api')
    const calls: Array<{ path: string; init: RequestInit }> = []
    const api = createChatApi({
      transport: async (path, init) => {
        calls.push({ path, init })
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
      },
      getToken: () => 'live-token',
    })
    await api.reportMessagesRead('public', 1, [])
    expect(calls).toHaveLength(0)

    await api.reportMessagesRead('public', 1, [7, 7, 9])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe('/messages/read')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ kind: 'public', roomId: 1, messageIds: [7, 9] })
  })
})

describe('mock/api 契约（#220）', () => {
  it('getMessages 出参带 readReceipts；发件人不出现在自己的 readBy（发件人恒已读口径）', async () => {
    const api = createMockChatApi()
    const page = await api.getMessages('public', 1)
    expect(page.messages.find((m) => m.id === 3)?.readReceipts).toBeDefined()
    expect(page.messages.find((m) => m.id === 1)?.readReceipts?.count).toBe(1)
    // 消息 1 是张三（id 1）发的：readBy 里不应有张三
    const mine = page.messages.find((m) => m.id === 1)!
    expect(mine.readReceipts?.readBy.some((r) => r.userId === 1)).toBe(false)
    // 消息 3 是小林（id 2）发的：readBy 不含小林
    const xiaolinMsg = page.messages.find((m) => m.id === 3)!
    expect(xiaolinMsg.readReceipts?.readBy.some((r) => r.userId === 2)).toBe(false)
  })

  it('reportMessagesRead 内存幂等：重复上报 count 不增、广播不重发', async () => {
    const api = createMockChatApi()
    await api.reportMessagesRead('public', 2, [12])
    await api.reportMessagesRead('public', 2, [12])
    const row = api.world.messagesByRoom.get('public:2')!.find((m) => m.id === 12)!
    expect(row.readReceipts?.count).toBe(1) // 重复上报：只落一次行

    // 幂等重放零事件：无新增 → 无 read_receipts 广播（ready 帧来自建连，不算）
    const pushed: unknown[] = []
    await storelessObserve(api, pushed)
    const receiptFrames = pushed.filter((f) => (f as { type?: string }).type === 'read_receipts')
    expect(receiptFrames).toHaveLength(0)
  })
})

describe('token 静默续期接线（#220，决策 #51）', () => {
  it('store.refreshSocketToken 经房间 socket 发 token_refresh 控制帧', async () => {
    const api = createMockChatApi()
    const store = createChatStore({
      api,
      storage: createChatStorageInert(),
      myUserId: () => api.world.me.id,
      getToken: () => 'mock-token',
    })
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    await flushPromises()

    store.refreshSocketToken('fresh-token')
    const outbox = api.lastSocket?.outbox ?? []
    expect(outbox).toHaveLength(1)
    expect(JSON.parse(outbox[0]!)).toEqual({ type: 'token_refresh', token: 'fresh-token' })
    store.closeSockets()
  })

  it('session：续期换新 token 触发 onTokenRenewed；首个 token 不触发（行为面=回调时序）', async () => {
    const { installFakeWindow, makeToken } = await import('./helpers/session-fake')
    const { createChatSession } = await import('../src/lib/session')
    const renewed: string[] = []
    const fake = installFakeWindow()
    const session = createChatSession({ onTokenRenewed: (token) => renewed.push(token) })

    const pending = session.handshake()
    const first = makeToken({ sub: '42' })
    fake.dispatch({ type: 'token', token: first })
    await pending
    expect(renewed).toEqual([]) // 首 token = 握手，不触发

    const second = makeToken({ sub: '42' })
    fake.dispatch({ type: 'token', token: second })
    expect(renewed).toEqual([second])
    expect(session.getToken()).toBe(second)
    session.dispose()
  })
})

// ---- 工具：不落盘的 storage 替身（storage.ts 属文件面外，用最小内联实现） ----
function createChatStorageInert(): import('../src/lib/storage').ChatStorage {
  const memory = new Map<string, string>()
  return {
    get: (key) => memory.get(key) ?? null,
    set: (key, value) => void memory.set(key, value),
    remove: (key) => void memory.delete(key),
    getJSON<T>(key: string, fallback: T): T {
      const raw = memory.get(key)
      return raw === undefined ? fallback : (JSON.parse(raw) as T)
    },
    setJSON: (key, value) => void memory.set(key, JSON.stringify(value)),
  }
}

/** 观察无 store 场景的广播面：临时挂一个 socket 再直呼幂等重放。 */
async function storelessObserve(
  api: ReturnType<typeof createMockChatApi>,
  pushed: unknown[],
): Promise<void> {
  const handle = api.openRoomSocket({
    kind: 'public',
    roomId: 2,
    token: 't',
    onMessage: (frame) => pushed.push(frame),
    onStatus: () => {},
  })
  await flushPromises()
  await api.reportMessagesRead('public', 2, [12])
  handle.close()
}

describe('本人身份解析（#229：coreUserId × contacts 双源，迟到就绪不丢判定）', () => {
  it('live 身份空间：contacts 含 core: 命名空间 → 必须精确映射 core:<sub>→id；映射缺失保持 0 不误判', async () => {
    const api = createMockChatApi(buildMockWorld())
    // 模拟 live：sub=9001，chat 内部 id=7（两个身份空间不同），JIT 用户 username=core:9001
    api.world.contacts.push({ id: 7, username: 'core:9001', displayName: '走查甲', avatarUrl: '' })
    api.world.contacts.push({ id: 8, username: 'core:9002', displayName: '走查乙', avatarUrl: '' })
    const store = createChatStore({
      api,
      storage: createChatStorageInert(),
      myUserId: () => 0, // 握手前：token 未就绪 → 0（#229 现场时序）
      getToken: () => 'mock-token',
    })
    // 握手前：0（不误判）
    expect(store.state.myUserId).toBe(0)

    // 握手完成（sub=9001），contacts 尚未载入 → 降级透出 core id（旧语义尽力窗口：
    // 大 sub 与小 chat id 无碰撞时已可用；载入 contacts 后切精确映射）
    const storeWithToken = createChatStore({
      api,
      storage: createChatStorageInert(),
      myUserId: () => 9001,
      getToken: () => 'mock-token',
    })
    expect(storeWithToken.state.coreUserId).toBe(9001)
    expect(storeWithToken.state.myUserId).toBe(9001)

    // contacts 载入（loadContacts 内触发 refreshMyUserId）→ 精确映射 9001→7
    await storeWithToken.loadContacts()
    expect(storeWithToken.state.myUserId).toBe(7)
    storeWithToken.closeSockets()
    store.closeSockets()
  })

  it('迟到身份：openRoom 早于身份解析 → 身份就绪后 refreshMyUserId 补判 mine（不再误报自读）', async () => {
    const api = createMockChatApi(buildMockWorld())
    const postSpy = vi.spyOn(api, 'reportMessagesRead')
    let currentCore = 0 // 模拟握手前 token 未就绪；后置 1 模拟握手+同构建档完成
    const store = createChatStore({
      api,
      storage: createChatStorageInert(),
      myUserId: () => currentCore,
      getToken: () => 'mock-token',
    })
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    await flushPromises()
    // 病灶：身份 0 → 连本人消息 id 1 也上报了（服务端 #229 兜底拦截）
    expect(postSpy.mock.calls[0]?.[2]).toContain(1)

    // 修复面：身份晚到（sub=1，同构世界）→ App 调 refreshMyUserId
    currentCore = 1
    store.refreshMyUserId()
    expect(store.state.myUserId).toBe(1)

    // 补判验证：本人迟到消息（WS 帧）→ 走 mine 分支：去重登记不触发上报；
    // 他人新消息照常帧内自动上报
    const callsBefore = postSpy.mock.calls.length
    store.receiveRoomFrame({
      protocolVersion: 1,
      type: 'message',
      message: baseMessage({
        id: 9,
        sender: { kind: 'local', id: 1, username: 'zhang', displayName: '张三', avatarUrl: '', source: 'local' },
      }),
    })
    await flushPromises()
    expect(postSpy.mock.calls.length).toBe(callsBefore) // 本人消息零上报

    store.receiveRoomFrame({
      protocolVersion: 1,
      type: 'message',
      message: baseMessage({
        id: 10,
        sender: { kind: 'local', id: 2, username: 'xiaolin', displayName: '小林', avatarUrl: '', source: 'local' },
      }),
    })
    await flushPromises()
    const last = postSpy.mock.calls[postSpy.mock.calls.length - 1]?.[2] ?? []
    expect(last).toEqual([10]) // 他人消息正常上报（帧内自动上报）
    store.closeSockets()
  })

  it('mock 同构世界：contacts 无 core: 命名空间 → 按 id 同构对上（旧行为兼容）', async () => {
    const api = createMockChatApi(buildMockWorld())
    const store = createChatStore({
      api,
      storage: createChatStorageInert(),
      myUserId: () => api.world.me.id,
      getToken: () => 'mock-token',
    })
    await store.loadContacts()
    expect(store.state.myUserId).toBe(api.world.me.id)
    store.closeSockets()
  })
})
