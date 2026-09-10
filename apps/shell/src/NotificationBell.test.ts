// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import type { NotificationItem } from './lib/notification-api'

/**
 * #19 通知铃铛：断言用户可见行为（徽章数字、下拉内容、点击后的未读变化、失败态人话），
 * 不断言内部 ref；替身只打在 HTTP 边界（mock lib/notification-api）。
 * 通知状态是模块级单例 → 每个用例 vi.resetModules() 后动态挂载，拿到干净单例。
 */

const api = vi.hoisted(() => ({
  fetchNotifications: vi.fn<() => Promise<NotificationItem[]>>(),
  fetchUnreadCount: vi.fn<() => Promise<number>>(),
  markNotificationRead: vi.fn<(id: string) => Promise<void>>(),
}))

vi.mock('./lib/notification-api', () => ({
  fetchNotifications: api.fetchNotifications,
  fetchUnreadCount: api.fetchUnreadCount,
  markNotificationRead: api.markNotificationRead,
}))

const MODULE_ITEM: NotificationItem = {
  id: 'n1',
  type: 'module_toggled',
  typeLabel: '模块状态已更新',
  payload: { moduleId: 'hello', moduleName: 'hello', enabled: true },
  isRead: false,
  createdAt: '2026-09-10 10:00:00',
}

const ACCOUNT_ITEM: NotificationItem = {
  id: 'n2',
  type: 'account_ready',
  typeLabel: '账号已开通',
  payload: { email: 'a@example.com' },
  isRead: true,
  createdAt: '2026-09-09 09:00:00',
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchNotifications.mockResolvedValue([])
  api.fetchUnreadCount.mockResolvedValue(0)
  api.markNotificationRead.mockResolvedValue(undefined)
})

/** 干净单例：重置模块图后重新挂载组件（use-notifications 单例随之新建）。 */
async function mountBell(): Promise<VueWrapper> {
  vi.resetModules()
  const { default: NotificationBell } = await import('./NotificationBell.vue')
  const wrapper = mount(NotificationBell)
  await flushPromises()
  return wrapper
}

async function openPanel(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.notification-bell-trigger').trigger('click')
  await flushPromises()
}

function itemContaining(wrapper: VueWrapper, text: string) {
  return wrapper.findAll('.notification-bell-item').find((item) => item.text().includes(text))
}

describe('NotificationBell（#19）', () => {
  it('未读徽章：有未读显示数字，无未读不显示徽章', async () => {
    api.fetchNotifications.mockResolvedValue([MODULE_ITEM])
    api.fetchUnreadCount.mockResolvedValue(2)
    const withUnread = await mountBell()
    expect(withUnread.find('.notification-bell-badge').text()).toBe('2')
    withUnread.unmount()

    api.fetchUnreadCount.mockResolvedValue(0)
    const withoutUnread = await mountBell()
    expect(withoutUnread.find('.notification-bell-badge').exists()).toBe(false)
    withoutUnread.unmount()
  })

  it('打开下拉：显示服务端类型名、契约摘要与原始时间；再点铃铛关闭', async () => {
    api.fetchNotifications.mockResolvedValue([MODULE_ITEM, ACCOUNT_ITEM])
    api.fetchUnreadCount.mockResolvedValue(1)
    const wrapper = await mountBell()

    // 未打开时不渲染下拉
    expect(wrapper.find('.notification-bell-panel').exists()).toBe(false)

    await openPanel(wrapper)

    const panel = wrapper.find('.notification-bell-panel')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('模块状态已更新')
    expect(panel.text()).toContain('「hello」已启用')
    expect(panel.text()).toContain('2026-09-10 10:00:00')
    expect(panel.text()).toContain('账号已开通')
    expect(panel.text()).toContain('a@example.com 已开通')

    await wrapper.find('.notification-bell-trigger').trigger('click')
    expect(wrapper.find('.notification-bell-panel').exists()).toBe(false)
    wrapper.unmount()
  })

  it('打开下拉触发刷新：服务端新数据进入面板并更新徽章', async () => {
    api.fetchNotifications.mockResolvedValue([MODULE_ITEM])
    api.fetchUnreadCount.mockResolvedValue(2)
    const wrapper = await mountBell()
    expect(wrapper.find('.notification-bell-badge').text()).toBe('2')

    api.fetchNotifications.mockResolvedValue([ACCOUNT_ITEM])
    api.fetchUnreadCount.mockResolvedValue(0)
    await openPanel(wrapper)

    const panel = wrapper.find('.notification-bell-panel')
    expect(panel.text()).toContain('账号已开通')
    expect(panel.text()).not.toContain('模块状态已更新')
    expect(wrapper.find('.notification-bell-badge').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点击未读项：调后端置读、徽章减一、该项转已读视觉且面板不关；已读项不再重复请求', async () => {
    api.fetchNotifications.mockResolvedValue([MODULE_ITEM, ACCOUNT_ITEM])
    api.fetchUnreadCount.mockResolvedValue(2)
    const wrapper = await mountBell()
    await openPanel(wrapper)

    const unread = itemContaining(wrapper, '模块状态已更新')
    expect(unread).toBeDefined()
    expect(unread!.classes()).toContain('notification-bell-item-unread')

    await unread!.trigger('click')
    await flushPromises()

    expect(api.markNotificationRead).toHaveBeenCalledTimes(1)
    expect(api.markNotificationRead).toHaveBeenCalledWith('n1')
    expect(wrapper.find('.notification-bell-badge').text()).toBe('1')
    expect(wrapper.find('.notification-bell-panel').exists()).toBe(true)
    expect(unread!.classes()).not.toContain('notification-bell-item-unread')

    // 本就已读的项再点：不发请求、未读不再减
    const read = itemContaining(wrapper, '账号已开通')
    await read!.trigger('click')
    await flushPromises()
    expect(api.markNotificationRead).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.notification-bell-badge').text()).toBe('1')
    wrapper.unmount()
  })

  it('加载失败：下拉显示人话错误、组件不崩', async () => {
    api.fetchNotifications.mockRejectedValue(new Error('请求失败（500）'))
    api.fetchUnreadCount.mockRejectedValue(new Error('请求失败（500）'))
    const wrapper = await mountBell()

    await openPanel(wrapper)

    expect(wrapper.find('.notification-bell-panel').text()).toContain('通知加载失败')
    wrapper.unmount()
  })

  it('无通知：下拉显示空态', async () => {
    const wrapper = await mountBell()
    await openPanel(wrapper)

    expect(wrapper.find('.notification-bell-panel').text()).toContain('暂无通知')
    wrapper.unmount()
  })

  it('摘要只认契约字段：缺字段或 payload 非对象时只显示类型名，不吐 undefined', async () => {
    api.fetchNotifications.mockResolvedValue([
      { ...MODULE_ITEM, id: 'n3', payload: { enabled: true } },
      {
        ...MODULE_ITEM,
        id: 'n4',
        type: 'invite_result',
        typeLabel: '邀请申请结果',
        payload: { approved: false },
      },
      { ...MODULE_ITEM, id: 'n5', type: 'gitea_event', typeLabel: '仓库动态', payload: 'not-an-object' },
    ])
    const wrapper = await mountBell()
    await openPanel(wrapper)

    const panel = wrapper.find('.notification-bell-panel')
    expect(panel.text()).toContain('邀请申请结果')
    expect(panel.text()).toContain('加入申请未通过')
    expect(panel.text()).toContain('仓库动态')
    expect(panel.text()).not.toContain('undefined')
    expect(panel.text()).not.toContain('已启用')
    wrapper.unmount()
  })

  it('点击遮罩关闭下拉；点击面板本身不关闭', async () => {
    api.fetchNotifications.mockResolvedValue([MODULE_ITEM])
    const wrapper = await mountBell()
    await openPanel(wrapper)

    await wrapper.find('.notification-bell-panel').trigger('click')
    expect(wrapper.find('.notification-bell-panel').exists()).toBe(true)

    await wrapper.find('.notification-bell-backdrop').trigger('click')
    expect(wrapper.find('.notification-bell-panel').exists()).toBe(false)
    wrapper.unmount()
  })
})
