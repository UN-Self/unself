// SPDX-License-Identifier: AGPL-3.0-only
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MessageList from '../src/components/MessageList.vue'
import { createChatApi } from '../src/lib/api'
import { createChatStore } from '../src/lib/chat-store'
import { userIdFromToken } from '../src/lib/session'
import { createChatStorage } from '../src/lib/storage'
import type { Message } from '../src/lib/types'

const me = { kind: 'local' as const, id: 7, username: 'core:u_alice', displayName: 'Alice', avatarUrl: '', source: 'local' }
const peer = { ...me, id: 8, username: 'core:u_bob', displayName: 'Bob' }
const message = (id: number, sender = me): Message => ({
  id, sender, content: `message ${id}`, createdAt: '2026-10-09T09:00:00Z',
  source: 'local', attachment: null, mentions: [], mentionUserIds: [],
})

function fixture(subject = 'u_alice', messages: Message[] = []) {
  let receive: (frame: unknown) => void = () => {}
  const reports: number[][] = []
  const api = createChatApi({
    getToken: () => 'test-token',
    transport: async (path, init) => {
      if (path === '/contacts') return Response.json({ users: [me, peer] })
      if (path.startsWith('/messages?')) return Response.json({ messages, pinnedMessage: null, room: { id: 15, kind: 'dm', name: 'Bob' } })
      if (path === '/messages/read') {
        reports.push(JSON.parse(String(init.body)).messageIds)
        return Response.json({ ok: true })
      }
      if (path === '/v1/rooms/dm/15/messages') return Response.json({ created: true, message: message(20) })
      throw new Error(`Unexpected request: ${path}`)
    },
    openRoomSocket: (handlers) => {
      receive = handlers.onMessage
      return { close() {} }
    },
  })
  const store = createChatStore({
    api, getToken: () => 'test-token',
    myUserId: () => userIdFromToken(() => ({ sub: subject }), 'test-token'),
    storage: createChatStorage({ getItem: () => null, setItem() {}, removeItem() {} }),
  })
  const wrapper = mount(defineComponent({
    setup: () => () => h(MessageList, {
      messages: store.state.messages, currentUserId: store.state.myUserId,
      readReceipts: store.state.readReceipts, isDm: true, audienceSize: 1,
      loadingEarlier: false, noEarlier: true,
    }),
  }))
  return { store, wrapper, reports, receive: (frame: unknown) => receive(frame) }
}

describe('真实 Core 身份的私聊回执', () => {
  it('字符串身份映射后，本人消息显示未读，收到对方回执后原地变已读', async () => {
    const f = fixture('u_alice', [
      { ...message(10), readReceipts: { count: 0, readBy: [] } },
      { ...message(11, peer), readReceipts: { count: 0, readBy: [] } },
    ])
    try {
      await f.store.loadContacts()
      await f.store.openRoom({ kind: 'dm', id: 15 }, 'Bob')
      await flushPromises()
      expect(f.wrapper.findAll('[aria-label="对方未读"]')).toHaveLength(1)
      expect(f.reports.flat()).toEqual([11])
      f.receive({ type: 'read_receipts', userId: 8, messageIds: [10], readAt: '2026-10-09T09:01:00Z' })
      await flushPromises()
      expect(f.wrapper.findAll('[aria-label="对方已读"]')).toHaveLength(1)
      expect(f.wrapper.find('[aria-label="对方未读"]').exists()).toBe(false)
    } finally { f.store.closeSockets(); f.wrapper.unmount() }
  })

  it('未映射的数字形状 Core ID 不得借用同号 Chat 身份或上报已读', async () => {
    const f = fixture('7', [{ ...message(10), readReceipts: { count: 0, readBy: [] } }])
    try {
      await f.store.openRoom({ kind: 'dm', id: 15 }, 'Bob')
      await flushPromises()
      expect(f.wrapper.find('[aria-label="对方未读"]').exists()).toBe(false)
      expect(f.reports).toEqual([])
      await f.store.loadContacts()
      await flushPromises()
      expect(f.reports).toEqual([])
    } finally { f.store.closeSockets(); f.wrapper.unmount() }
  })

  it('联系人晚到仍补报他人消息，且不把自己的消息算作已读', async () => {
    const f = fixture('u_alice', [
      { ...message(10), readReceipts: { count: 0, readBy: [] } },
      { ...message(11, peer), readReceipts: { count: 0, readBy: [] } },
    ])
    try {
      await f.store.openRoom({ kind: 'dm', id: 15 }, 'Bob')
      expect(f.reports).toEqual([])
      await f.store.loadContacts()
      await flushPromises()
      expect(f.reports.flat()).toEqual([11])
      expect(f.wrapper.find('[aria-label="对方未读"]').exists()).toBe(true)
    } finally { f.store.closeSockets(); f.wrapper.unmount() }
  })

  it('新发送消息立即显示未读；回执先到、发送回显后到也不退回未读', async () => {
    const f = fixture()
    try {
      await f.store.loadContacts()
      await f.store.openRoom({ kind: 'dm', id: 15 }, 'Bob')
      await f.store.sendMessage({ content: 'hello' })
      await flushPromises()
      expect(f.wrapper.find('[aria-label="对方未读"]').exists()).toBe(true)
      f.receive({ type: 'read_receipts', userId: 8, messageIds: [21], readAt: '2026-10-09T09:01:00Z' })
      f.receive({ type: 'message', message: { ...message(21), readReceipts: { count: 0, readBy: [] } } })
      await flushPromises()
      expect(f.wrapper.findAll('[aria-label="对方已读"]')).toHaveLength(1)
      expect(f.wrapper.findAll('[aria-label="对方未读"]')).toHaveLength(1)
      expect(f.reports).toEqual([])
    } finally { f.store.closeSockets(); f.wrapper.unmount() }
  })
})
