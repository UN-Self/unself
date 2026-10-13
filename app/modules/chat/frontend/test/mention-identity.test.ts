// SPDX-License-Identifier: AGPL-3.0-only
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import Composer from '../src/components/Composer.vue'
import { createChatStore } from '../src/lib/chat-store'
import { createMockChatApi } from '../src/lib/mock-api'
import { createChatStorage } from '../src/lib/storage'
import type { UserSummary } from '../src/lib/types'

/**
 * #230 @ 提及 × core 身份（行为面）：live 模式 JIT 身份 username=`core:<sub>`（含冒号），
 * displayName 为中文展示名。三处 ASCII 白名单曾让 @core:2 / @走查乙 双双失效：
 * 回填恒空（mentionUserIds=[]）、`@走` 直接关浮层。
 *
 * 盯的是「输入文本 → emit mentionUserIds」与「浮层候选」两条用户可见结果，
 * 不断言内部函数/实现细节。
 */

enableAutoUnmount(afterEach)
Object.defineProperty(Range.prototype, 'getClientRects', { value: () => [], configurable: true })
Object.defineProperty(Range.prototype, 'getBoundingClientRect', { value: () => new DOMRect(), configurable: true })

const contacts: UserSummary[] = [
  { id: 1, username: 'core:1', displayName: '走查甲', avatarUrl: '' },
  { id: 2, username: 'core:2', displayName: '走查乙', avatarUrl: '' },
]

async function mountComposer(props: Record<string, unknown> = {}) {
  const wrapper = mount(Composer, { attachTo: document.body, props: { contextKey: 'channel.1', contacts, ...props } })
  await flushPromises()
  return wrapper
}

async function setValue(wrapper: Awaited<ReturnType<typeof mountComposer>>, value: string) {
  const input = wrapper.get('[data-test="composer-input"]')
  input.element.textContent = value
  const range = document.createRange(); range.selectNodeContents(input.element); range.collapse(false)
  window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
  await input.trigger('input'); await flushPromises()
}
function inputOf(wrapper: Awaited<ReturnType<typeof mountComposer>>) {
  const input = wrapper.get('[data-test="composer-input"]')
  return { element: input.element, trigger: input.trigger.bind(input) }
}

function optionsOf(wrapper: Awaited<ReturnType<typeof mountComposer>>) {
  return wrapper.findAll('[data-test^="mention-option-"]')
}

describe('#230 core 身份下的 @ 提及', () => {
  it('@core:2 与 @走查乙（展示名）两种输入都产出 mentionUserIds=[2]', async () => {
    const wrapper = await mountComposer()
    const input = inputOf(wrapper)

    await setValue(wrapper, '@core:2 回执请确认')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[0]).toEqual(['@core:2 回执请确认', [2]])

    await setValue(wrapper, '@走查乙 回执请确认')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[1]).toEqual(['@走查乙 回执请确认', [2]])
  })

  it('@走（非 ASCII）与 @core:2（含冒号）都保留候选浮层；username/displayName 双向匹配', async () => {
    const wrapper = await mountComposer()

    await setValue(wrapper, '@走')
    expect(optionsOf(wrapper).map((option) => option.attributes('data-test'))).toEqual([
      'mention-option-core:1',
      'mention-option-core:2',
    ])

    await setValue(wrapper, '@core:2')
    expect(optionsOf(wrapper).map((option) => option.attributes('data-test'))).toEqual([
      'mention-option-core:2',
    ])
  })

  it('删除提及文本后 mentionUserIds 同步移除（回填随文本增删，不是一次性快照）', async () => {
    const wrapper = await mountComposer()
    const input = inputOf(wrapper)

    await setValue(wrapper, '@core:2 在吗')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[0]?.[1]).toEqual([2])

    await setValue(wrapper, '在吗')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[1]?.[1]).toEqual([])
  })

  it('@bobby 不误判为 @bob（词边界），@走查乙， 收尾标点仍算提及', async () => {
    const wrapper = await mountComposer({
      contacts: [...contacts, { id: 3, username: 'bob', displayName: 'Bob', avatarUrl: '' }],
    })
    const input = inputOf(wrapper)

    await setValue(wrapper, '@bobby 你好')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[0]?.[1]).toEqual([])

    await setValue(wrapper, '@走查乙，回执请确认')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[1]?.[1]).toEqual([2])
  })

  it('浮层选中插入 @core:2（服务端按 content 含 username 复核提及），随即重解析回同一 id', async () => {
    const wrapper = await mountComposer()
    const input = inputOf(wrapper)

    await setValue(wrapper, '@走查')
    expect(optionsOf(wrapper)).toHaveLength(2)

    await optionsOf(wrapper)[1]!.trigger('mousedown')
    expect(input.element.textContent).toBe('@core:2 ')

    await setValue(wrapper, '@core:2 麻烦确认')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[0]?.[1]).toEqual([2])
  })
})

describe('#230 提及数据面：mock 链路的接收方 @未读投影', () => {
  it('@走查乙 → mentionUserIds=[2] → mock 解析 mentions → room_message(mentionsMe) 使 mentionUnreadCount +1', async () => {
    const api = createMockChatApi()
    // live core 身份：主角 = core:2（走查乙），联系人走 core:<sub> 命名空间
    api.world.me = { id: 2, username: 'core:2', displayName: '走查乙', avatarUrl: '' }
    api.world.contacts = contacts
    const store = createChatStore({
      api,
      storage: createChatStorage(),
      myUserId: () => Number(api.world.me.username.slice('core:'.length)),
      getToken: () => 'mock-token',
    })
    await store.loadChannels()
    await store.loadDms()
    await store.loadContacts()

    // 发送侧：composer 对展示名输入产出 mentionUserIds
    const wrapper = await mountComposer()
    const input = inputOf(wrapper)
    await setValue(wrapper, '@走查乙 看一下')
    await input.trigger('keydown', { key: 'Enter' })
    const [, mentionUserIds] = wrapper.emitted('send')![0]!
    expect(mentionUserIds).toEqual([2])

    // mock 面：发送后按 id 解析出 mentions（id 空间与接收方一致）
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    await store.sendMessage({
      content: '@走查乙 看一下',
      mentionUserIds: mentionUserIds as number[],
    })
    const sentId = store.state.messages.at(-1)!.id
    const sent = api.world.messagesByRoom.get('public:1')!.find((row) => row.id === sentId)!
    expect(sent.mentions.map((mention) => mention.displayName)).toEqual(['走查乙'])

    // 接收方投影：另一会话的 room_message 帧（mentionsMe=true）→ 该会话 @未读 +1
    const channel2 = api.world.channels.find((channel) => channel.id === 2)!
    const before = channel2.mentionUnreadCount
    store.receiveInboxFrame({
      protocolVersion: 1,
      type: 'room_message',
      room: { id: 2, kind: 'public', name: 'random' },
      messageId: 90_001,
      createdAt: '2026-09-16 10:00:00',
      unreadCount: channel2.unreadCount + 1,
      mentionUnreadCount: before + 1,
      mentionsMe: true,
      replyToMe: false,
      contentPreview: '@走查乙 看一下',
      sender: {
        kind: 'local',
        id: 1,
        username: 'core:1',
        displayName: '走查甲',
        avatarUrl: '',
        source: 'edgechat',
      },
    })
    expect(channel2.mentionUnreadCount).toBe(before + 1)
    store.closeSockets()
  })
})
