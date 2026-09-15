// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import RoomList from '../src/components/RoomList.vue'
import type { Channel, Dm } from '../src/lib/types'

/**
 * 会话列表行为（#218）：选中事件 + 未读角标 + 空态/加载态。
 * 改坏（点击不 emit / 角标不显示 / 空态消失）→ 红；重构样式 → 绿。
 */

const channel = (over: Partial<Channel> = {}): Channel => ({
  id: 7,
  name: 'general',
  description: '',
  kind: 'public',
  isGeneral: true,
  ownerDisplayName: 'o',
  isMember: true,
  myRole: 'member',
  canManage: false,
  memberCount: 3,
  lastMessageAt: null,
  unreadCount: 0,
  mentionUnreadCount: 0,
  ...over,
})

const dm = (over: Partial<Dm> = {}): Dm => ({
  id: 9,
  kind: 'dm',
  name: 'dm-9',
  lastMessageAt: null,
  unreadCount: 0,
  mentionUnreadCount: 0,
  otherUser: { id: 3, username: 'alice', displayName: 'Alice', avatarUrl: '' },
  isBlockedByMe: false,
  ...over,
})

function mountList(props: Partial<InstanceType<typeof RoomList>['$props']> = {}) {
  return mount(RoomList, {
    props: { channels: [], dms: [], loading: false, activeRoom: null, ...props },
  })
}

describe('RoomList（#218）', () => {
  it('空数据 → 空态「暂无会话」，无任何房间按钮', () => {
    const wrapper = mountList()
    expect(wrapper.find('[data-test="rooms-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="room-channel-7"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('加载中 → 骨架屏（role=status），列表未渲染', () => {
    const wrapper = mountList({ loading: true, channels: [channel()] })
    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="room-channel-7"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('频道/私聊分段渲染；点击发出 select（kind/id 正确）', async () => {
    const wrapper = mountList({ channels: [channel()], dms: [dm()] })

    await wrapper.find('[data-test="room-channel-7"]').trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual([{ kind: 'public', id: 7 }])

    await wrapper.find('[data-test="room-dm-9"]').trigger('click')
    expect(wrapper.emitted('select')?.[1]).toEqual([{ kind: 'dm', id: 9 }])
    wrapper.unmount()
  })

  it('未读角标显示数（>99 折叠 99+）；无未读无角标', async () => {
    const wrapper = mountList({ channels: [channel({ unreadCount: 2 }), channel({ id: 8, name: 'big', unreadCount: 120 })] })

    const badges = wrapper.findAll('[data-test="unread-badge"]')
    expect(badges).toHaveLength(2)
    expect(badges[0]!.text()).toBe('2')
    expect(badges[1]!.text()).toBe('99+')

    await wrapper.setProps({ channels: [channel()] })
    expect(wrapper.find('[data-test="unread-badge"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('选中态：activeRoom 命中的行带 aria-current', async () => {
    const wrapper = mountList({ channels: [channel()], activeRoom: { kind: 'public', id: 7 } })
    expect(wrapper.find('[data-test="room-channel-7"]').attributes('aria-current')).toBe('true')

    await wrapper.setProps({ activeRoom: { kind: 'public', id: 8 } })
    expect(wrapper.find('[data-test="room-channel-7"]').attributes('aria-current')).toBeUndefined()
    wrapper.unmount()
  })

  it('私聊行显示对方昵称', () => {
    const wrapper = mountList({ dms: [dm()] })
    expect(wrapper.text()).toContain('Alice')
    wrapper.unmount()
  })
})
