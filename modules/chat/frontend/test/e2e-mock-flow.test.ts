// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { createMockChatApi, buildMockWorld } from '../src/lib/mock-api'
import { createChatStore } from '../src/lib/chat-store'
import { createChatStorage } from '../src/lib/storage'

/**
 * 端到端行为链路（#218 验收「发/收/分页/@/文件/语音全链路通」的 mock 闭环）：
 * 以 mock 世界为替身（docs/testing.md：替身只出现在外部边界），驱动真实 store：
 * - 会话列表 → 打开房间 → 历史就绪 → 幂等发送 → WS 广播回显去重 → 未读投影
 * - 语音/文件附件经 uploadFile → attachment → 发送 → 到达对端
 */
describe('mock 全链路：列表 → 房间 → 发送/接收（WS）→ 附件', () => {
  it('打开房间显示历史，发送文本 → created 回包入列；WS 广播回显不重复', async () => {
    const api = createMockChatApi()
    const store = createChatStore({
      api,
      storage: createChatStorage(),
      myUserId: () => api.world.me.id,
      getToken: () => 'mock-token',
    })

    await store.loadChannels()
    await store.loadDms()
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    expect(store.state.loadingHistory).toBe('ready')
    expect([...store.state.messages].map((m) => m.id)).toEqual([3, 2, 1])

    // 发送：REST 回包入列
    await store.sendMessage({ content: '你好，**加粗**', mentionUserIds: [] })
    expect(store.state.sendError).toBe('')
    expect(store.state.messages.at(-1)?.content).toBe('你好，**加粗**')
    expect(store.state.messages.at(-1)?.sender.id).toBe(api.world.me.id)

    // WS 广播回显（服务端把该消息再推给房间）：不重复插入
    const last = store.state.messages.at(-1)!
    store.receiveRoomFrame({ protocolVersion: 1, type: 'message', message: last })
    expect(store.state.messages.filter((m) => m.id === last.id)).toHaveLength(1)

    // 他人 WS 消息 → 尾插
    store.receiveRoomFrame({
      protocolVersion: 1,
      type: 'message',
      message: {
        id: 20_001,
        content: '小林：收到',
        mentionUserIds: [],
        mentions: [],
        createdAt: '2026-09-16 10:00:00',
        source: 'edgechat',
        sender: {
          kind: 'local',
          id: 2,
          username: 'xiaolin',
          displayName: '小林',
          avatarUrl: '',
          source: 'edgechat',
        },
        attachment: null,
      },
    })
    expect(store.state.messages.at(-1)?.content).toBe('小林：收到')
    store.closeSockets()
  })

  it('历史分页：上翻拿更早一页；首页 <30 条 → noEarlier（hasMoreHistory=false）', async () => {
    const world = buildMockWorld()
    // 灌 45 条历史到 random 频道（id 降序排）
    const rows = Array.from({ length: 45 }, (_, i) => ({
      id: 45 - i,
      content: `历史消息 ${45 - i}`,
      mentionUserIds: [],
      mentions: [],
      createdAt: `2026-09-14 08:${String(i % 60).padStart(2, '0')}:00`,
      source: 'edgechat',
      sender: {
        kind: 'local' as const,
        id: 2,
        username: 'xiaolin',
        displayName: '小林',
        avatarUrl: '',
        source: 'edgechat',
      },
      attachment: null,
      roomId: 2,
    }))
    world.messagesByRoom.set('public:2', rows)
    const api = createMockChatApi(world)
    const store = createChatStore({
      api,
      storage: createChatStorage(),
      myUserId: () => api.world.me.id,
      getToken: () => 'mock-token',
    })

    await store.openRoom({ kind: 'public', id: 2 }, 'random')
    expect(store.state.messages).toHaveLength(30)
    expect(store.state.hasMoreHistory).toBe(true)

    await store.loadOlderMessages()
    expect(store.state.messages).toHaveLength(45)
    expect(store.state.hasMoreHistory).toBe(false)

    // 再翻无更多（幂等空操作）
    await store.loadOlderMessages()
    expect(store.state.messages).toHaveLength(45)
    store.closeSockets()
  })

  it('语音全链路：uploadFile → attachment(kind=voice) → 发送 → 对端房间可见', async () => {
    const api = createMockChatApi()
    const store = createChatStore({
      api,
      storage: createChatStorage(),
      myUserId: () => api.world.me.id,
      getToken: () => 'mock-token',
    })
    await store.openRoom({ kind: 'dm', id: 101 }, '小林')

    const blob = new Blob(['voice-bytes'], { type: 'audio/webm' })
    const file = new File([blob], 'voice-1.webm', { type: 'audio/webm' })
    const uploaded = await store.uploadFile(file)
    if (!uploaded) throw new Error('uploadFile 应返回附件')
    expect(uploaded.kind).toBeUndefined() // 上传产物是通用附件；kind 由发送方标记
    const attachment = { ...uploaded, kind: 'voice' as const, durationMs: 9400, waveform: [10, 50, 90, 30] }
    await store.sendMessage({ content: '', attachment })
    const last = store.state.messages.at(-1)!
    expect(last.attachment?.kind).toBe('voice')
    expect(last.attachment?.durationMs).toBe(9400)
    // 对端视角：mock 世界里同一行
    const row = api.world.messagesByRoom.get('dm:101')!.find((m) => m.id === last.id)!
    expect(row.attachment?.waveform).toEqual([10, 50, 90, 30])
    store.closeSockets()
  })

  it('@ 提及链路：mentionUserIds → mock 解析出 mentions → WS 未读投影 mentionUnreadCount 增长', async () => {
    const api = createMockChatApi()
    const store = createChatStore({
      api,
      storage: createChatStorage(),
      myUserId: () => api.world.me.id,
      getToken: () => 'mock-token',
    })
    await store.loadChannels()
    await store.loadDms()
    await store.loadContacts()

    // 我在 general 里发 @小林：mock sendMessage 把 mentionUserIds 解析为 mentions
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    await store.sendMessage({ content: '@小林 看一下', mentionUserIds: [2] })
    expect(store.state.messages.at(-1)?.mentions.map((m) => m.displayName)).toEqual(['小林'])

    // 模拟另一房间来帧（我不在场）：未读投影 +1；mentionsMe 时 @未读 +1
    const before = api.world.channels.find((c) => c.id === 2)!.unreadCount
    const beforeMention = api.world.channels.find((c) => c.id === 2)!.mentionUnreadCount
    store.receiveInboxFrame({
      protocolVersion: 1,
      type: 'room_message',
      room: { id: 2, kind: 'public', name: 'random' },
      messageId: 30_001,
      createdAt: '2026-09-16 10:00:00',
      unreadCount: before + 1,
      mentionUnreadCount: 1,
      mentionsMe: true,
      replyToMe: false,
      contentPreview: '在吗',
      sender: {
        kind: 'local',
        id: 3,
        username: 'laowang',
        displayName: '老王',
        avatarUrl: '',
        source: 'edgechat',
      },
    })
    const channel2 = api.world.channels.find((c) => c.id === 2)!
    expect(channel2.unreadCount).toBe(before + 1)
    expect(channel2.mentionUnreadCount).toBe(beforeMention + 1)
    store.closeSockets()
  })

  it('未打开会话时发送为空操作（不插入、不报错）；token 缺失 → realtimeStatus=error', async () => {
    const api = createMockChatApi()
    const store = createChatStore({
      api,
      storage: createChatStorage(),
      myUserId: () => api.world.me.id,
      getToken: () => null,
    })
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    expect(store.state.realtimeStatus).toBe('error')
    store.closeSockets()

    // 全新 store、未打开任何会话（currentRoom=null）：发送为空操作，不插入不崩溃
    const idle = createChatStore({
      api,
      storage: createChatStorage(),
      myUserId: () => api.world.me.id,
      getToken: () => 'mock-token',
    })
    await idle.sendMessage({ content: '不应到达' })
    expect(idle.state.messages.some((m) => m.content === '不应到达')).toBe(false)
  })
})
