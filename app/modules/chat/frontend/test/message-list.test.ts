// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  roomKey?: string
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
afterEach(() => vi.unstubAllGlobals())

describe('MessageList（#218）', () => {
  it('首次带历史消息挂载就定位到底部，不需要再收到新消息', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2400)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
    const wrapper = await mountList({ messages: [msg(1, 2), msg(2, 1)] })
    const el = wrapper.get('[data-test="message-stream"]').element as HTMLElement
    expect(el.scrollTop).toBeGreaterThanOrEqual(2000)
    wrapper.unmount()
  })

  it('点击消息导航可以定位旧消息；点击回到最新重新触底', async () => {
    const wrapper = await mountList({ messages: [msg(1, 2), msg(2, 1)] })
    const viewport = wrapper.get('[data-test="message-stream"]')
    const el = viewport.element as HTMLElement
    installScrollGeometry(el, { scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 })
    await viewport.trigger('scroll')
    await wrapper.get('button[aria-label="定位消息：对方用户，hello-1"]').trigger('click')
    expect(el.scrollTop).toBeLessThan(1600)
    await wrapper.get('button[aria-label="回到最新消息"]').trigger('click')
    expect(el.scrollTop).toBeGreaterThanOrEqual(1600)
    wrapper.unmount()
  })

  it('切换到消息条数相同的会话也重新定位到底部', async () => {
    const wrapper = await mountList({ roomKey: 'public:1', messages: [msg(1, 2), msg(2, 1)] })
    const viewport = wrapper.get('[data-test="message-stream"]')
    const el = viewport.element as HTMLElement
    installScrollGeometry(el, { scrollTop: 300, scrollHeight: 2000, clientHeight: 400 })
    await viewport.trigger('scroll')
    await wrapper.setProps({ roomKey: 'dm:2', messages: [msg(10, 2), msg(11, 1)] })
    await wrapper.vm.$nextTick()
    expect(el.scrollTop).toBeGreaterThanOrEqual(1600)
    wrapper.unmount()
  })

  it('前插历史时补偿新增高度，保留正在阅读的位置', async () => {
    const wrapper = await mountList({ messages: [msg(3, 2), msg(4, 1)] })
    const viewport = wrapper.get('[data-test="message-stream"]')
    const el = viewport.element as HTMLElement
    installScrollGeometry(el, { scrollTop: 50, scrollHeight: 2000, clientHeight: 400 })
    await viewport.trigger('scroll')
    // 几何边界：模拟浏览器在 Vue 更新 DOM 后增加内容高度。
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () =>
      el.querySelectorAll('[data-message-id]').length > 2 ? 2400 : 2000,
    })
    await wrapper.setProps({ messages: [msg(1, 2), msg(2, 1), msg(3, 2), msg(4, 1)] })
    await wrapper.vm.$nextTick()
    expect(el.scrollTop).toBe(450)
    wrapper.unmount()
  })

  it.each([false, true])('侧轨使用平滑滚动；减少动态效果=%s 时立即定位', async (reduce) => {
    vi.stubGlobal('matchMedia', () => ({ matches: reduce }))
    const wrapper = await mountList({ messages: [msg(1, 2), msg(2, 1)] })
    const viewport = wrapper.get('[data-test="message-stream"]')
    const el = viewport.element as HTMLElement
    installScrollGeometry(el, { scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 })
    const scroll = vi.fn((options: ScrollToOptions) => { el.scrollTop = options.top ?? 0 })
    el.scrollTo = scroll as unknown as HTMLElement['scrollTo']
    await viewport.trigger('scroll')
    await wrapper.get('button[aria-label="定位消息：对方用户，hello-1"]').trigger('click')
    expect(scroll).toHaveBeenLastCalledWith({ top: 1400, behavior: reduce ? 'auto' : 'smooth' })
    await wrapper.get('button[aria-label="回到最新消息"]').trigger('click')
    expect(scroll).toHaveBeenLastCalledWith({ top: 2000, behavior: reduce ? 'auto' : 'smooth' })
    wrapper.unmount()
  })

  it('延迟布局增高时贴底跟随，离底阅读时不跳动', async () => {
    let resized: () => void = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe() {}
      disconnect() {}
    })
    const wrapper = await mountList({ messages: [msg(1, 2), msg(2, 1)] })
    const viewport = wrapper.get('[data-test="message-stream"]')
    const el = viewport.element as HTMLElement
    installScrollGeometry(el, { scrollTop: 1600, scrollHeight: 2400, clientHeight: 400 })
    resized()
    expect(el.scrollTop).toBe(2400)
    el.scrollTop = 300
    await viewport.trigger('scroll')
    installScrollGeometry(el, { scrollTop: 300, scrollHeight: 2800, clientHeight: 400 })
    resized()
    expect(el.scrollTop).toBe(300)
    wrapper.unmount()
  })

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
