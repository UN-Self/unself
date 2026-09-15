// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import ChatLayout from '../src/components/ChatLayout.vue'

/**
 * 布局骨架行为（#218，docs/testing.md 两问检验）：
 * 布局模式唯一判定源 = matchMedia（窄屏 ≤768px 单栏，桌面双栏）——
 * 改坏判定（如把窄屏当桌面）→ 断言红；重构样式/类名 → 断言不动，绿。
 * 断言全部打在用户可见结果（区域在场性/事件），零类名断言。
 */

type Listener = (event: { matches: boolean }) => void

let narrowMatches = false
const mqlListeners = new Set<Listener>()

function installMatchMedia(initialNarrow: boolean): void {
  narrowMatches = initialNarrow
  mqlListeners.clear()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => {
      expect(query).toBe('(max-width: 768px)')
      return {
        get matches() {
          return narrowMatches
        },
        addEventListener: (_t: string, l: Listener) => mqlListeners.add(l),
        removeEventListener: (_t: string, l: Listener) => mqlListeners.delete(l),
      }
    },
  })
}

function flipTo(narrow: boolean): void {
  narrowMatches = narrow
  for (const l of mqlListeners) l({ matches: narrow })
}

const channel = {
  id: 7,
  name: 'general',
  description: '',
  kind: 'public' as const,
  isGeneral: true,
  ownerDisplayName: 'o',
  isMember: true,
  myRole: 'member',
  canManage: false,
  memberCount: 3,
  lastMessageAt: null,
  unreadCount: 2,
  mentionUnreadCount: 0,
}

const message = (id: number, senderId: number) => ({
  id,
  content: `hello-${id}`,
  mentionUserIds: [],
  mentions: [],
  createdAt: '2026-09-16T09:00:00',
  source: 'local',
  sender: { kind: 'local' as const, id: senderId, username: 'u', displayName: '走查用户', avatarUrl: '', source: 'local' },
  attachment: null,
})

beforeEach(() => {
  installMatchMedia(false)
})

describe('ChatLayout 布局切换（#218）', () => {
  it('桌面（matchMedia false）双栏：列表与消息流同屏', async () => {
    const wrapper = mount(ChatLayout, {
      props: {
        channels: [channel],
        dms: [],
        activeRoom: { kind: 'public', id: 7, name: 'general' },
        messages: [message(1, 2)],
        currentUserId: 1,
        loadingRooms: false,
        loadingMessages: false,
        loadingEarlier: false,
        noEarlier: true,
      },
    })

    await flushPromises()

    expect(wrapper.find('[data-test="list-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="room-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="back-button"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('窄屏（matchMedia true）未选中房间 → 只显示列表，无返回钮', async () => {
    installMatchMedia(true)
    const wrapper = mount(ChatLayout, {
      props: {
        channels: [channel],
        dms: [],
        activeRoom: null,
        messages: [],
        currentUserId: 1,
        loadingRooms: false,
        loadingMessages: false,
        loadingEarlier: false,
        noEarlier: false,
      },
    })
    await flushPromises()

    expect(wrapper.find('[data-test="list-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="room-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="back-button"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('窄屏选中房间 → 只显示消息流页，返回钮在场，back 事件可发', async () => {
    installMatchMedia(true)
    const wrapper = mount(ChatLayout, {
      props: {
        channels: [channel],
        dms: [],
        activeRoom: { kind: 'public', id: 7, name: 'general' },
        messages: [message(1, 2)],
        currentUserId: 1,
        loadingRooms: false,
        loadingMessages: false,
        loadingEarlier: false,
        noEarlier: true,
      },
    })
    await flushPromises()

    expect(wrapper.find('[data-test="room-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="list-pane"]').exists()).toBe(false)

    await wrapper.find('[data-test="back-button"]').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
    wrapper.unmount()
  })

  it('视口从桌面翻到窄屏 → 布局随之切换单栏（监听 matchMedia 翻转）', async () => {
    const wrapper = mount(ChatLayout, {
      props: {
        channels: [channel],
        dms: [],
        activeRoom: { kind: 'public', id: 7, name: 'general' },
        messages: [],
        currentUserId: 1,
        loadingRooms: false,
        loadingMessages: false,
        loadingEarlier: false,
        noEarlier: false,
      },
    })
    await flushPromises()
    expect(wrapper.find('[data-test="back-button"]').exists()).toBe(false)

    flipTo(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="back-button"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('room 标题/未读数流转：标题随 activeRoom，未读徽标来自列表数据', async () => {
    const wrapper = mount(ChatLayout, {
      props: {
        channels: [channel],
        dms: [],
        activeRoom: { kind: 'public', id: 7, name: 'general' },
        messages: [],
        currentUserId: 1,
        loadingRooms: false,
        loadingMessages: false,
        loadingEarlier: false,
        noEarlier: false,
      },
    })
    await flushPromises()

    expect(wrapper.find('[data-test="room-title"]').text()).toBe('general')
    const badge = wrapper.find('[data-test="unread-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('2')

    await wrapper.setProps({ activeRoom: { kind: 'public', id: 7, name: 'random' } })
    expect(wrapper.find('[data-test="room-title"]').text()).toBe('random')
    wrapper.unmount()
  })
})
