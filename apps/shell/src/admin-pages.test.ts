// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminLayout from './AdminLayout.vue'
import MembersPage from './admin/MembersPage.vue'
import SettingsPage from './admin/SettingsPage.vue'
import { fetchMe } from './lib/session-api'
import {
  fetchMembers,
  fetchSettings,
  saveSettings,
  setMemberStatus,
  SECRET_MASK,
} from './lib/admin-api'
import { testOidcConnection } from './lib/setup-api'

/**
 * 管理台行为测试（#17，docs/testing.md 两问检验）：
 * - 守卫：非 admin 访问 /admin → 重定向工作台（用户可见结果 = 路由变了）
 * - 成员页：confirm 停用 → 发出 disable 请求 → 徽章翻转
 * - 设置页：保存只发改动字段（密钥留空不回传）→ 成功提示；测试连接 warnings 黄牌可见
 */

vi.mock('./lib/session-api', () => ({
  fetchMe: vi.fn(),
  loginUrl: (next?: string) => `/api/auth/login${next ? `?next=${encodeURIComponent(next)}` : ''}`,
  logout: vi.fn(),
}))

vi.mock('./lib/admin-api', () => ({
  SECRET_MASK: '***',
  fetchMembers: vi.fn(),
  setMemberStatus: vi.fn(),
  fetchAdminModules: vi.fn(),
  toggleModule: vi.fn(),
  fetchAuditLog: vi.fn(),
  fetchSettings: vi.fn(),
  saveSettings: vi.fn(),
}))

vi.mock('./lib/setup-api', () => ({
  testOidcConnection: vi.fn(),
}))

const adminMember = {
  id: 'u1',
  display_name: '黄一',
  email: 'h1@example.com',
  status: 'active' as const,
  role: 'user',
  created_at: '2026-09-01 08:00:00',
}

async function mountAdminLayout(): Promise<{ currentPath: () => string; wrapper: ReturnType<typeof mount> }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div data-test="workspace" />' } },
      { path: '/admin/:page?', component: AdminLayout },
    ],
  })
  router.push('/admin/members')
  await router.isReady()
  const wrapper = mount(AdminLayout, { global: { plugins: [router] } })
  await flushPromises()
  return { currentPath: () => router.currentRoute.value.path, wrapper }
}

describe('AdminLayout 守卫（#17）', () => {
  it('非 admin 访问 /admin → 重定向工作台', async () => {
    vi.mocked(fetchMe).mockResolvedValue({
      authenticated: true,
      user: { id: 'u2', name: '成员', issuer: 'i', sub: 's', role: 'user' },
    })
    const { currentPath } = await mountAdminLayout()
    expect(currentPath()).toBe('/')
  })

  it('admin 停留并渲染管理导航（成员/模块/审计/设置四入口）', async () => {
    vi.mocked(fetchMe).mockResolvedValue({
      authenticated: true,
      user: { id: 'u1', name: '管理', issuer: 'i', sub: 's', role: 'admin' },
    })
    const { currentPath, wrapper } = await mountAdminLayout()
    expect(currentPath()).toBe('/admin/members')
    const labels = wrapper.findAll('a').map((a) => a.text().trim())
    for (const label of ['成员', '模块', '审计', '设置']) {
      expect(labels.some((t) => t.includes(label))).toBe(true)
    }
  })
})

describe('MembersPage 停用/启用（#17）', () => {
  beforeEach(() => {
    // 每例新对象：用例内的状态翻转不得泄漏到下一例
    vi.mocked(fetchMembers).mockResolvedValue([{ ...adminMember }])
    vi.mocked(setMemberStatus).mockResolvedValue({})
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  it('confirm 停用 → 发出 disable 请求 → 状态徽章翻转为已停用', async () => {
    const wrapper = mount(MembersPage)
    await flushPromises()

    const disableBtn = wrapper.findAll('button').find((b) => b.text().includes('停用'))
    expect(disableBtn).toBeDefined()
    await disableBtn!.trigger('click')
    await flushPromises()

    expect(setMemberStatus).toHaveBeenCalledWith('u1', 'disabled')
    expect(wrapper.text()).toContain('已停用')
  })

  it('confirm 取消 → 不发请求，状态不变', async () => {
    vi.mocked(setMemberStatus).mockClear()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const wrapper = mount(MembersPage)
    await flushPromises()

    const disableBtn = wrapper.findAll('button').find((b) => b.text().includes('停用'))
    await disableBtn!.trigger('click')
    await flushPromises()

    expect(setMemberStatus).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('已停用')
  })

  it('已停用成员显示启用按钮，点击直接启用（无 confirm）', async () => {
    vi.mocked(fetchMembers).mockResolvedValue([{ ...adminMember, status: 'disabled' as const }])
    const wrapper = mount(MembersPage)
    await flushPromises()

    const enableBtn = wrapper.findAll('button').find((b) => b.text().includes('启用'))
    await enableBtn!.trigger('click')
    await flushPromises()

    expect(window.confirm).not.toHaveBeenCalled()
    expect(setMemberStatus).toHaveBeenCalledWith('u1', 'active')
    expect(wrapper.text()).toContain('正常')
  })
})

describe('SettingsPage 保存与测试连接（#17）', () => {
  beforeEach(() => {
    vi.mocked(fetchSettings).mockResolvedValue({
      oidc: { issuer: 'https://idp.example.com', clientId: 'c1', clientSecret: SECRET_MASK, scope: 'openid' },
      mail: {
        baseUrl: 'https://mail.example.com',
        apiKey: SECRET_MASK,
        domain: 'example.com',
        host: '',
        port: '',
        username: '',
        password: '',
        from: '',
      },
    })
    vi.mocked(saveSettings).mockResolvedValue({ ok: true })
  })

  it('保存：密钥留空 → PUT body 不含密钥字段，只发改动/非空字段', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    // 改 issuer；其余留原值；两个密钥输入框保持空
    const inputs = wrapper.findAll('input')
    const issuerInput = inputs.find((i) => (i.element as HTMLInputElement).value === 'https://idp.example.com')
    await issuerInput!.setValue('https://new.example.com')

    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存')
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(saveSettings).toHaveBeenCalledTimes(1)
    const body = vi.mocked(saveSettings).mock.calls[0]![0] as Record<string, Record<string, unknown>>
    // 非密钥字段全量回传（服务端等值覆盖无害），密钥留空则绝不出现
    expect(body.oidc).toEqual({ issuer: 'https://new.example.com', clientId: 'c1', scope: 'openid' })
    expect(body.oidc?.clientSecret).toBeUndefined()
    expect(body.mail?.apiKey).toBeUndefined()
    expect(body.mail?.password).toBeUndefined()
    expect(wrapper.text()).toContain('已保存')
  })

  it('测试连接成功 + IdP 缺 nonce → 黄牌警告可见', async () => {
    vi.mocked(testOidcConnection).mockResolvedValue({
      ok: true,
      issuer: 'https://idp.example.com',
      warnings: ['该 IdP 可能无法完成登录（不回显 nonce）'],
    })
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const testBtn = wrapper.findAll('button').find((b) => b.text().includes('测试连接'))
    await testBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('连接成功')
    expect(wrapper.text()).toContain('该 IdP 可能无法完成登录（不回显 nonce）')
  })

  it('测试连接失败 → 人话原因可见（不显示成功）', async () => {
    vi.mocked(testOidcConnection).mockResolvedValue({ ok: false, reason: '无法访问该 Issuer：请检查地址是否正确或网络可达性' })
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const testBtn = wrapper.findAll('button').find((b) => b.text().includes('测试连接'))
    await testBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('无法访问该 Issuer')
    expect(wrapper.text()).not.toContain('连接成功')
  })
})
