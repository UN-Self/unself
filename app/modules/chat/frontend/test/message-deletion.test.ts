// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageBubble from '../src/components/MessageBubble.vue'
import MessageRail from '../src/components/MessageRail.vue'
import { createChatStore } from '../src/lib/chat-store'
import { createChatStorage } from '../src/lib/storage'
import { createMockChatApi } from '../src/lib/mock-api'
import type { Message } from '../src/lib/types'

const originalMessage = (): Message => ({
  id: 800, content: '撤回前的正文', mentionUserIds: [2],
  mentions: [{ userId: 2, username: 'bob', displayName: 'Bob' }],
  createdAt: '2026-10-10T08:00:00Z', source: 'local',
  sender: { kind: 'local', id: 1, username: 'alice', displayName: 'Alice', avatarUrl: '', source: 'local' },
  attachment: { key: 'private', name: '私有文件.pdf', type: 'application/pdf', size: 100, url: '/files/private' },
  readReceipts: { count: 1, readBy: [{ userId: 2, username: 'bob', displayName: 'Bob', readAt: 'now' }] },
})
let original: Message
beforeEach(() => { original = originalMessage() })

async function setup() {
  const api = createMockChatApi()
  const store = createChatStore({ api, storage: createChatStorage(), myUserId: () => 1, getToken: () => 'mock-token' })
  await store.openRoom({ kind: 'public', id: 1 }, 'general')
  return { api, store }
}

describe('#323 撤回事件的前端处理', () => {
  it('事件保留消息位置，清除正文/附件/提及/回执和引用副本；重复事件幂等', async () => {
    const { store } = await setup()
    try {
      store.receiveRoomFrame({ protocolVersion: 1, type: 'message', message: original })
      store.receiveRoomFrame({ protocolVersion: 1, type: 'message', message: {
        ...original, id: 801, content: '我的回复', attachment: null, replyToMessageId: original.id, replyTo: original,
      } })
      const ids = store.state.messages.map((message) => message.id)
      for (let i = 0; i < 2; i++) store.receiveRoomFrame({ protocolVersion: 1, type: 'message_deleted', messageId: original.id })
      const deleted = store.state.messages.find((message) => message.id === original.id)!
      expect(deleted).toMatchObject({ id: original.id, deleted: true, content: '', attachment: null, mentions: [], mentionUserIds: [] })
      expect(deleted.readReceipts).toBeUndefined()
      expect(store.state.readReceipts[original.id]).toBeUndefined()
      expect(store.state.messages.at(-1)?.replyTo).toEqual({ id: original.id, deleted: true })
      expect(store.state.messages.map((message) => message.id)).toEqual(ids)
    } finally { store.closeSockets() }
  })

  it('撤回事件先到时，迟到的消息与回执不会恢复内容', async () => {
    const { store } = await setup()
    try {
      store.receiveRoomFrame({ protocolVersion: 1, type: 'message_deleted', messageId: original.id })
      store.receiveRoomFrame({ protocolVersion: 1, type: 'message', message: original })
      store.receiveRoomFrame({ protocolVersion: 1, type: 'read_receipts', messageId: original.id, messageIds: [original.id], userId: 2, readAt: 'now' })
      expect(store.state.messages.at(-1)).toMatchObject({ deleted: true, content: '', attachment: null })
      expect(store.state.readReceipts[original.id]).toBeUndefined()
    } finally { store.closeSockets() }
  })

  it('撤回消息的气泡隐藏旧正文、文件、语音、引用与回执', () => {
    for (const kind of [undefined, 'voice'] as const) {
      const wrapper = mount(MessageBubble, { props: {
        message: { ...original, deleted: true, attachment: { ...original.attachment!, kind } },
        mine: true, replyPreview: '旧引用内容', readSummary: original.readReceipts,
      } })
      try {
        expect(wrapper.text()).toContain('消息已撤回')
        expect(wrapper.text()).not.toContain(original.content)
        expect(wrapper.text()).not.toContain('旧引用内容')
        expect(wrapper.find('a').exists()).toBe(false)
        expect(wrapper.find('[data-test="voice-bubble"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="bubble-receipt"]').exists()).toBe(false)
      } finally { wrapper.unmount() }
    }
  })

  it('侧边导航的预览和无障碍标签只显示撤回占位', () => {
    const wrapper = mount(MessageRail, { props: { messages: [{ ...original, deleted: true }], activeId: original.id, following: true } })
    try {
      expect(wrapper.text()).toContain('消息已撤回')
      expect(wrapper.html()).not.toContain(original.content)
      expect(wrapper.html()).not.toContain(original.attachment!.name)
    } finally { wrapper.unmount() }
  })
})
