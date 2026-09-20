// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import MessageList from '../src/components/MessageList.vue'
import type { Message } from '../src/lib/types'

/**
 * 消息流行为（#218）：渲染分组、mine/theirs 分侧、上翻加载、贴底跟随、空态。
 * 假滚动容器直接喂 scrollTop/scrollHeight/clientHeight（行为面 = scroll 回调读到的几何值）。
 */

const msg = (id: number, senderId: number, over: Partial<Message> = {}): Message => ({
  id,
  content: `hello-${id}`,
  mentionUserIds: [],
  mentions: [],
  createdAt: '2026-09-16T09:00:00',
  source: 'local',
  sender: {
    kind: 'local',
    id: senderId,
    username: 'u',
    displayName: senderId === 1 ? '走查用户' : '对方用户',
    avatarUrl: '',
    source: 'local',
  },
  attachment: null,
  ...over,
})

function installScrollGeometry(el: HTMLElement, geo: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  // writable: true——scrollToBottom 需要真的能赋值 scrollTop（行为面之一）
  Object.defineProperty(el, 'scrollTop', { value: geo.scrollTop, writable: true, configurable: true })
  Object.defineProperty(el, 'scrollHeight', { value: geo.scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: geo.clientHeight, configurable: true })
}

async function mountList(props: {
  messages?: Message[]
  loadingEarlier?: boolean
  noEarlier?: boolean
  currentUserId?: number
}) {
  const wrapper = mount(MessageList, {
    props: {
      messages: [],
      currentUserId: 1,
      loadingEarlier: false,
      noEarlier: false,
      ...props,
    },
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('MessageList（#218）', () => {
  it('消息按 mine/theirs 分侧渲染；正文与时刻可见', async () => {
    const wrapper = await mountList({ messages: [msg(1, 2), msg(2, 1)] })

    expect(wrapper.find('[data-test="bubble-theirs"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="bubble-mine"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('hello-1')
    expect(wrapper.text()).toContain('09:00')
    wrapper.unmount()
  })

  it('同日消息一个日期分隔条（今天），跨日两条', async () => {
    const wrapper = await mountList({
      messages: [msg(1, 2), { ...msg(2, 2), createdAt: '2026-09-15T08:00:00' }],
    })
    expect(wrapper.findAll('[data-test="day-divider"]')).toHaveLength(2)
    wrapper.unmount()
  })

  it('空流 → 空态骨架占位（stream-empty 在场）', async () => {
    const wrapper = await mountList({})
    expect(wrapper.find('[data-test="stream-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="bubble-theirs"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('贴近顶部滚动 → emit load-earlier 一次；远离顶部不触发', async () => {
    const wrapper = await mountList({ messages: [msg(1, 2), msg(2, 2)] })
    const el = wrapper.find('[data-test="message-stream"]').element as HTMLElement
    installScrollGeometry(el, { scrollTop: 0, scrollHeight: 2000, clientHeight: 400 })

    await wrapper.find('[data-test="message-stream"]').trigger('scroll')
    expect(wrapper.emitted('load-earlier')).toHaveLength(1)

    // 未重新武装前（loadingEarlier 未翻转）不重复触发
    await wrapper.find('[data-test="message-stream"]').trigger('scroll')
    expect(wrapper.emitted('load-earlier')).toHaveLength(1)

    // loadingEarlier 翻回 false（新批次到达）→ 重新武装
    await wrapper.setProps({ loadingEarlier: true })
    await wrapper.setProps({ loadingEarlier: false })
    await wrapper.find('[data-test="message-stream"]').trigger('scroll')
    expect(wrapper.emitted('load-earlier')).toHaveLength(2)

    // 离顶远 → 不触发
    installScrollGeometry(el, { scrollTop: 1000, scrollHeight: 4000, clientHeight: 400 })
    await wrapper.find('[data-test="message-stream"]').trigger('scroll')
    expect(wrapper.emitted('load-earlier')).toHaveLength(2)
    wrapper.unmount()
  })

  it('loadingEarlier → 顶部加载态；noEarlier → 没有更早提示（且有消息才显示）', async () => {
    const wrapper = await mountList({ messages: [msg(1, 2)], loadingEarlier: true })
    expect(wrapper.find('[data-test="loading-earlier"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="no-earlier"]').exists()).toBe(false)

    await wrapper.setProps({ loadingEarlier: false, noEarlier: true })
    expect(wrapper.find('[data-test="loading-earlier"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="no-earlier"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('新消息到达且原本贴底 → 容器被滚到底；离底浏览历史 → 不拽人', async () => {
    const wrapper = await mountList({ messages: [msg(1, 2), msg(2, 2)] })
    const el = wrapper.find('[data-test="message-stream"]').element as HTMLElement

    // 贴底态：距底 100 < 阈值 100
    installScrollGeometry(el, { scrollTop: 1500, scrollHeight: 2000, clientHeight: 400 })
    await wrapper.setProps({ messages: [msg(1, 2), msg(2, 2), msg(3, 2)] })
    await wrapper.vm.$nextTick()
    expect(el.scrollTop).toBe(2000)

    // 离底态：距底 800 → 新消息不自动滚
    installScrollGeometry(el, { scrollTop: 800, scrollHeight: 4000, clientHeight: 400 })
    await wrapper.setProps({ messages: [msg(1, 2), msg(2, 2), msg(3, 2), msg(4, 2)] })
    await wrapper.vm.$nextTick()
    expect(el.scrollTop).toBe(800)
    wrapper.unmount()
  })
})
