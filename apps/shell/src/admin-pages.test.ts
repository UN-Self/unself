// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminLayout from './AdminLayout.vue'
import InvitesPage from './admin/InvitesPage.vue'
import MembersPage from './admin/MembersPage.vue'
import SettingsPage from './admin/SettingsPage.vue'
import { fetchMe } from './lib/session-api'
import {
  approveInvite,
  createInvite,
  fetchInvites,
  fetchMembers,
  fetchSettings,
  makeApiError,
  rejectInvite,
  saveSettings,
  setMemberStatus,
  SECRET_MASK,
  testMailConnection,
} from './lib/admin-api'
import { testOidcConnection } from './lib/setup-api'
import { resetMemberPassword } from './lib/builtin-auth-api'

/**
 * 管理台行为测试（#17，docs/testing.md 两问检验）：
 * - 守卫：非 admin 访问 /admin → 重定向工作台（用户可见结果 = 路由变了）
 * - 成员页：confirm 停用 → 发出 disable 请求 → 徽章翻转
 * - 邀请页：批准/拒绝按钮只对 pending 出现；批准翻转行状态、拒绝先 confirm；生成链接只显示一次（#18）
 * - 设置页：保存只发改动字段（密钥留空不回传）→ 成功提示；测试连接 warnings 黄牌可见
 */

vi.mock('./lib/session-api', () => ({
  fetchMe: vi.fn(),
  loginUrl: (next?: string) => `/api/auth/login${next ? `?next=${encodeURIComponent(next)}` : ''}`,
  logout: vi.fn(),
}))

vi.mock('./lib/admin-api', () => ({
  SECRET_MASK: '***',
  makeApiError: (status: number, message: string, requestId?: string, detail?: string) =>
    Object.assign(new Error(message), { status, requestId, detail }),
  fetchMembers: vi.fn(),
  setMemberStatus: vi.fn(),
  fetchAdminModules: vi.fn(),
  toggleModule: vi.fn(),
  fetchAuditLog: vi.fn(),
  fetchSettings: vi.fn(),
  saveSettings: vi.fn(),
  testMailConnection: vi.fn(),
  fetchInvites: vi.fn(),
  createInvite: vi.fn(),
  approveInvite: vi.fn(),
  rejectInvite: vi.fn(),
}))

vi.mock('./lib/setup-api', () => ({
  testOidcConnection: vi.fn(),
}))

vi.mock('./lib/builtin-auth-api', () => ({
  resetMemberPassword: vi.fn(),
  getAuthMethods: vi.fn(),
  loginWithPassword: vi.fn(),
  createBuiltinAdmin: vi.fn(),
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
      // #168：/api/me 新字段（本用例与邮件轴无关，按未开轴）。
      mailEnabled: false,
      mailPortalUrl: null,
    })
    const { currentPath } = await mountAdminLayout()
    expect(currentPath()).toBe('/')
  })

  it('admin 停留并渲染管理导航（成员/邀请/模块/审计/设置五入口）', async () => {
    vi.mocked(fetchMe).mockResolvedValue({
      authenticated: true,
      user: { id: 'u1', name: '管理', issuer: 'i', sub: 's', role: 'admin' },
      mailEnabled: false,
      mailPortalUrl: null,
    })
    const { currentPath, wrapper } = await mountAdminLayout()
    expect(currentPath()).toBe('/admin/members')
    const labels = wrapper.findAll('a').map((a) => a.text().trim())
    for (const label of ['成员', '邀请', '模块', '审计', '设置']) {
      expect(labels.some((t) => t.includes(label))).toBe(true)
    }
  })
})

describe('MembersPage 停用/启用（#17 + #192 F6）', () => {
  beforeEach(() => {
    // 调用史清零：上一例的 setMemberStatus/resetMemberPassword 调用不得泄漏到下一例的「未调用」断言
    vi.clearAllMocks()
    // 每例新对象：用例内的状态翻转不得泄漏到下一例
    vi.mocked(fetchMembers).mockResolvedValue([{ ...adminMember }])
    vi.mocked(setMemberStatus).mockResolvedValue({})
    vi.mocked(resetMemberPassword).mockResolvedValue(undefined)
    // #192 F6：原生弹窗已退场；两个 spy 返回「取消」值，旧路径一旦回归用例必红
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    vi.spyOn(window, 'prompt').mockReturnValue(null)
  })

  /** 站内确认弹层（#192 F6）内按钮：按文本定位，避开与行内同名按钮相撞。 */
  async function clickDialogButton(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
    const dialog = wrapper.find('.u-confirm')
    expect(dialog.exists()).toBe(true)
    const btn = dialog.findAll('button').find((b) => b.text() === label)
    expect(btn).toBeDefined()
    await btn!.trigger('click')
    await flushPromises()
  }

  it('停用：行内点「停用」只开站内弹层不发请求，弹层确认后才 disable → 徽章翻为已停用', async () => {
    const wrapper = mount(MembersPage)
    await flushPromises()

    const disableBtn = wrapper.findAll('button').find((b) => b.text().includes('停用'))
    expect(disableBtn).toBeDefined()
    await disableBtn!.trigger('click')
    await flushPromises()

    // 站内弹层已开，且确认前不发请求（与旧 confirm 行为一致：二次确认语义保留）
    expect(wrapper.find('.u-confirm').text()).toContain('确定停用')
    expect(window.confirm).not.toHaveBeenCalled()
    expect(setMemberStatus).not.toHaveBeenCalled()

    await clickDialogButton(wrapper, '停用')

    expect(setMemberStatus).toHaveBeenCalledWith('u1', 'disabled')
    expect(wrapper.text()).toContain('已停用')
  })

  it('停用：弹层点取消 → 不发请求，状态不变', async () => {
    const wrapper = mount(MembersPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('停用'))!.trigger('click')
    await flushPromises()
    await clickDialogButton(wrapper, '取消')

    expect(setMemberStatus).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('已停用')
  })

  it('停用：弹层 Esc 关闭（不发请求，弹层退场）', async () => {
    const wrapper = mount(MembersPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('停用'))!.trigger('click')
    await flushPromises()

    await wrapper.find('.u-confirm').trigger('keydown', { key: 'Escape' })
    await flushPromises()

    expect(wrapper.find('.u-confirm').exists()).toBe(false)
    expect(setMemberStatus).not.toHaveBeenCalled()
  })

  it('已停用成员显示启用按钮，点击直接启用（无弹层、无原生确认）', async () => {
    vi.mocked(fetchMembers).mockResolvedValue([{ ...adminMember, status: 'disabled' as const }])
    const wrapper = mount(MembersPage)
    await flushPromises()

    const enableBtn = wrapper.findAll('button').find((b) => b.text().includes('启用'))
    await enableBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.find('.u-confirm').exists()).toBe(false)
    expect(window.confirm).not.toHaveBeenCalled()
    expect(setMemberStatus).toHaveBeenCalledWith('u1', 'active')
    expect(wrapper.text()).toContain('正常')
  })

  it('重置密码：弹层内两次一致（≥8 位）→ resetMemberPassword 被调 → 成功提示可见', async () => {
    const wrapper = mount(MembersPage)
    await flushPromises()

    const resetBtn = wrapper.findAll('button').find((b) => b.text().includes('重置密码'))
    expect(resetBtn).toBeDefined()
    await resetBtn!.trigger('click')
    await flushPromises()

    // 站内输入替代 window.prompt（#192 F6）
    expect(window.prompt).not.toHaveBeenCalled()
    await wrapper.find('#u-confirm-password').setValue('new-password-9')
    await wrapper.find('#u-confirm-password-2').setValue('new-password-9')
    await clickDialogButton(wrapper, '重置')

    expect(resetMemberPassword).toHaveBeenCalledWith('u1', 'new-password-9')
    expect(wrapper.find('[role="status"]').text()).toContain('已重置')
  })

  it('重置密码：长度不足 8 位 → 人话提示 + 不发请求', async () => {
    const wrapper = mount(MembersPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('重置密码'))!.trigger('click')
    await flushPromises()

    await wrapper.find('#u-confirm-password').setValue('short')
    await wrapper.find('#u-confirm-password-2').setValue('short')
    await clickDialogButton(wrapper, '重置')

    expect(wrapper.find('.u-confirm').text()).toContain('密码长度至少 8 位')
    expect(resetMemberPassword).not.toHaveBeenCalled()
  })

  it('重置密码：两次输入不一致 → 人话提示 + 不发请求', async () => {
    const wrapper = mount(MembersPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('重置密码'))!.trigger('click')
    await flushPromises()

    await wrapper.find('#u-confirm-password').setValue('new-password-9')
    await wrapper.find('#u-confirm-password-2').setValue('new-password-8')
    await clickDialogButton(wrapper, '重置')

    expect(wrapper.find('.u-confirm').text()).toContain('两次输入的密码不一致')
    expect(resetMemberPassword).not.toHaveBeenCalled()
  })

  it('重置密码：弹层点取消 → 不发请求', async () => {
    const wrapper = mount(MembersPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('重置密码'))!.trigger('click')
    await flushPromises()
    await clickDialogButton(wrapper, '取消')

    expect(resetMemberPassword).not.toHaveBeenCalled()
  })

  it('重置密码 409（OIDC 用户）：后端人话行内可见', async () => {
    vi.mocked(resetMemberPassword).mockRejectedValue(
      Object.assign(new Error('该成员无内置登录'), { status: 409 }),
    )
    const wrapper = mount(MembersPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('重置密码'))!.trigger('click')
    await flushPromises()
    await wrapper.find('#u-confirm-password').setValue('new-password-9')
    await wrapper.find('#u-confirm-password-2').setValue('new-password-9')
    await clickDialogButton(wrapper, '重置')

    expect(wrapper.find('[role="alert"]').text()).toContain('该成员无内置登录')
  })
})

describe('SettingsPage 保存与测试连接（#17）', () => {
  beforeEach(() => {
    // 调用史清零：上一例的 saveSettings 调用不得泄漏到下一例的「调用次数」断言
    vi.clearAllMocks()
    vi.mocked(fetchSettings).mockResolvedValue({
      oidc: { issuer: 'https://idp.example.com', clientId: 'c1', clientSecret: SECRET_MASK, scope: 'openid' },
      mail: {
        enabled: true,
        baseUrl: 'https://mail.example.com',
        apiKey: SECRET_MASK,
        domain: 'example.com',
        host: '',
        port: '',
        username: '',
        password: '',
        from: '',
        portalUrl: '',
      },
    })
    vi.mocked(saveSettings).mockResolvedValue({ ok: true })
  })

  it('#184：填了邮箱门户地址 → PUT 带 portalUrl；清空 → PUT 带空串（后端清覆盖、回落推导）', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    // 填值保存：PUT 里出现 portalUrl
    const portal = wrapper.findAll('input').find((i) => i.attributes('placeholder')?.includes('留空'))
    expect(portal).toBeDefined()
    await portal!.setValue('https://portal.example.com/app-passwords')
    await wrapper.findAll('button').find((b) => b.text().includes('保存'))!.trigger('click')
    await flushPromises()
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ mail: expect.objectContaining({ portalUrl: 'https://portal.example.com/app-passwords' }) }),
    )

    // 清空再保存：空串（= 让后端删掉覆盖键、回落按域名推导），不是「不发该字段」
    vi.mocked(saveSettings).mockClear()
    await portal!.setValue('')
    await wrapper.findAll('button').find((b) => b.text().includes('保存'))!.trigger('click')
    await flushPromises()
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ mail: expect.objectContaining({ portalUrl: '' }) }),
    )
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

  it('邮件测试失败（#139）→ 错误文案只在邮件卡内，不落在 OIDC 卡', async () => {
    vi.mocked(testMailConnection).mockRejectedValue(makeApiError(502, '邮件服务不可达：请检查 Stalwart 地址'))
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const [oidcCard, mailCard] = wrapper.findAll('[data-test="settings-card"]')
    const mailTestBtn = mailCard!.findAll('button').find((b) => b.text().includes('测试连接'))
    await mailTestBtn!.trigger('click')
    await flushPromises()

    expect(mailCard!.text()).toContain('邮件服务不可达')
    expect(mailCard!.find('[role="alert"]').exists()).toBe(true)
    expect(oidcCard!.text()).not.toContain('邮件服务不可达')
    expect(oidcCard!.find('[role="alert"]').exists()).toBe(false)
  })

  it('OIDC 测试与邮件测试互不影响（#139）→ loading 独立，结果各归各卡', async () => {
    let resolveOidc!: (v: { ok: true; issuer: string; warnings: string[] }) => void
    vi.mocked(testOidcConnection).mockImplementation(
      () => new Promise((res) => { resolveOidc = res }),
    )
    vi.mocked(testMailConnection).mockResolvedValue({
      provisioner: { ok: true, detail: '邮箱已创建' },
      sender: { ok: true, detail: '发信成功' },
    })
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const [oidcCard, mailCard] = wrapper.findAll('[data-test="settings-card"]')
    const oidcBtn = oidcCard!.findAll('button').find((b) => b.text().includes('测试连接'))!
    const mailBtn = mailCard!.findAll('button').find((b) => b.text().includes('测试连接'))!

    await oidcBtn.trigger('click')
    await flushPromises()
    // OIDC 在途转圈，邮件按钮不受牵连
    expect(oidcBtn.attributes('aria-busy')).toBe('true')
    expect(mailBtn.attributes('aria-busy')).toBeUndefined()

    await mailBtn.trigger('click')
    await flushPromises()
    // 邮件测试完成，结果在邮件卡内；OIDC 仍在途、无结果
    expect(mailCard!.text()).toContain('邮箱已创建')
    expect(mailCard!.text()).toContain('发信成功')
    expect(oidcCard!.text()).not.toContain('连接成功')
    expect(oidcBtn.attributes('aria-busy')).toBe('true')

    resolveOidc({ ok: true, issuer: 'https://idp.example.com', warnings: [] })
    await flushPromises()
    expect(oidcCard!.text()).toContain('连接成功')
    // 邮件结果不被 OIDC 结果冲掉
    expect(mailCard!.text()).toContain('发信成功')
  })
})

// ---------------------------------------------------------------------------
// SettingsPage 邮件轴开关（P4/T3）：enabled 可操作化
// ---------------------------------------------------------------------------

describe('SettingsPage 邮件轴开关（P4）', () => {
  beforeEach(() => {
    // saveSettings mock 是模块级共享的：清掉前序用例的调用痕迹（计数断言才可信）
    vi.mocked(saveSettings).mockClear()
    vi.mocked(fetchSettings).mockResolvedValue({
      oidc: { issuer: 'https://idp.example.com', clientId: 'c1', clientSecret: SECRET_MASK, scope: 'openid' },
      mail: {
        enabled: true,
        baseUrl: 'https://mail.example.com',
        apiKey: SECRET_MASK,
        domain: 'example.com',
        host: '',
        port: '',
        username: '',
        password: '',
        from: '',
        portalUrl: '',
      },
    })
    vi.mocked(saveSettings).mockResolvedValue({ ok: true })
  })

  function findSwitch(wrapper: ReturnType<typeof mount>) {
    return wrapper.find('button[role="switch"]')
  }

  it('#159 表单语义：切换开关不发请求（只改本地状态并收起配置区），点「保存」才 PUT mail.enabled=false', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const sw = findSwitch(wrapper)
    expect(sw.attributes('aria-checked')).toBe('true')

    await sw.trigger('click')
    await flushPromises()

    // 切换不发请求；折叠立即生效（本地表单状态）
    expect(saveSettings).not.toHaveBeenCalled()
    expect(findSwitch(wrapper).attributes('aria-checked')).toBe('false')
    const config = wrapper.find('[data-test="mail-config"]')
    expect(config.classes()).not.toContain('is-open')
    expect(config.attributes('aria-hidden')).toBe('true')

    // 保存 → 随其余字段一次落库（enabled:false，关≠清配置：无其它字段被下发）
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存')
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(saveSettings).toHaveBeenCalledTimes(1)
    const body = vi.mocked(saveSettings).mock.calls[0]![0] as Record<string, Record<string, unknown>>
    // enabled 随保存落库；密钥字段绝不回传（MASK 语义）
    expect(body.mail!.enabled).toBe(false)
    expect(body.mail!.apiKey).toBeUndefined()
    expect(body.mail!.password).toBeUndefined()
  })

  it('关闭态：配置区收起（grid-rows 过渡容器无 is-open + inert）+ 测试按钮 disabled + 灰字提示在场', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await findSwitch(wrapper).trigger('click')
    await flushPromises()

    const config = wrapper.find('[data-test="mail-config"]')
    expect(config.exists()).toBe(true)
    expect(config.classes()).not.toContain('is-open')
    expect(config.attributes('inert')).toBeDefined()
    expect(config.attributes('aria-hidden')).toBe('true')

    const mailTestBtn = config.findAll('button').find((b) => b.text().includes('测试连接'))
    expect(mailTestBtn!.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('关闭后新成员不再开户与发信；已开通的邮箱不受影响')
    expect(wrapper.text()).not.toContain('填写并保存配置后即可开启')
  })

  it('#159 无 mail 行（全字段空、密钥未配置）→ 开关 off+disabled、配置区**展开**（需先填表）、测试禁用；保存配置后开关解锁', async () => {
    vi.mocked(fetchSettings).mockResolvedValue({
      oidc: { issuer: 'https://idp.example.com', clientId: 'c1', clientSecret: SECRET_MASK, scope: 'openid' },
      mail: {
        enabled: true,
        baseUrl: '',
        apiKey: '',
        domain: '',
        host: '',
        port: '',
        username: '',
        password: '',
        from: '',
        portalUrl: '',
      },
    })
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const sw = findSwitch(wrapper)
    expect(sw.attributes('aria-checked')).toBe('false')
    expect(sw.attributes('disabled')).toBeDefined()
    await sw.trigger('click')
    await sw.trigger('keydown', { key: 'Enter' })
    expect(saveSettings).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('填写并保存配置后即可开启')

    // 无配置 → 配置区展开（用户要能填表）、测试按钮禁用
    const config = wrapper.find('[data-test="mail-config"]')
    expect(config.classes()).toContain('is-open')
    expect(config.attributes('inert')).toBeUndefined()
    const testBtn = config.findAll('button').find((b) => b.text().includes('测试连接'))
    expect(testBtn!.attributes('disabled')).toBeDefined()

    // 填写并保存 → 创建 mail 行且带 enabled（表单语义：开关值随保存落库）
    const baseUrlInput = wrapper.findAll('input').find(
      (i) => i.attributes('placeholder') === 'https://mail.example.com',
    )
    await baseUrlInput!.setValue('https://mail.example.com')
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存')
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveSettings).mock.calls[0]![0]).toEqual({
      oidc: { issuer: 'https://idp.example.com', clientId: 'c1', scope: 'openid' },
      mail: { baseUrl: 'https://mail.example.com', enabled: true },
    })
    expect(findSwitch(wrapper).attributes('disabled')).toBeUndefined()
    expect(findSwitch(wrapper).attributes('aria-checked')).toBe('true')
    expect(wrapper.text()).not.toContain('填写并保存配置后即可开启')
  })

  it('保存失败 → role=alert 显示错误（不触发「已保存」）；开关保持用户所选（本地表单态，未落库）', async () => {
    vi.mocked(saveSettings).mockRejectedValueOnce(makeApiError(500, '保存失败：服务端错误'))
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await findSwitch(wrapper).trigger('click')
    await flushPromises()
    expect(findSwitch(wrapper).attributes('aria-checked')).toBe('false')

    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存')
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toContain('保存失败：服务端错误')
    expect(wrapper.text()).not.toContain('已保存')
  })
})

// ---------------------------------------------------------------------------
// InvitesPage（#18）：审批与一次性链接
// ---------------------------------------------------------------------------

const pendingInvite = {
  token_hash: 'tok-pending',
  status: 'pending' as const,
  personal_email: 'alice@personal.example.com',
  email_prefix: 'alice',
  display_name: '小艾',
  created_at: '2026-09-01 08:00:00',
  expires_at: '2026-09-08 08:00:00',
}

function buttonTexts(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('button').map((b) => b.text())
}

describe('InvitesPage 审批与生成（#18）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 每例新对象：用例内的状态翻转不得泄漏到下一例
    vi.mocked(fetchInvites).mockResolvedValue([{ ...pendingInvite }])
    vi.mocked(createInvite).mockResolvedValue({ inviteUrl: 'https://unself.example.com/invite/abc123' })
    vi.mocked(approveInvite).mockResolvedValue({ status: 'approved', email: 'alice@example.com' })
    vi.mocked(rejectInvite).mockResolvedValue({ status: 'rejected' })
    // #192 F6：拒绝改站内确认，原生 confirm 已退场；spy 返回「取消」值——旧路径回归用例必红
    vi.spyOn(window, 'confirm').mockReturnValue(false)
  })

  it('列表：五态中文徽章可见，空态显示「还没有邀请」', async () => {
    vi.mocked(fetchInvites).mockResolvedValue([
      { ...pendingInvite },
      { ...pendingInvite, token_hash: 't2', status: 'approved' as const },
      { ...pendingInvite, token_hash: 't3', status: 'rejected' as const },
      { ...pendingInvite, token_hash: 't4', status: 'consumed' as const },
      { ...pendingInvite, token_hash: 't5', status: 'expired' as const },
    ])
    const wrapper = mount(InvitesPage)
    await flushPromises()
    for (const label of ['待审批', '已批准', '已拒绝', '已入职', '已过期']) {
      expect(wrapper.text()).toContain(label)
    }

    vi.mocked(fetchInvites).mockResolvedValue([])
    const empty = mount(InvitesPage)
    await flushPromises()
    expect(empty.text()).toContain('还没有邀请')
  })

  it('pending 行有批准/拒绝按钮，approved 行没有', async () => {
    vi.mocked(fetchInvites).mockResolvedValue([
      { ...pendingInvite },
      { ...pendingInvite, token_hash: 'tok-approved', status: 'approved' as const },
    ])
    const wrapper = mount(InvitesPage)
    await flushPromises()

    const rows = wrapper.findAll('[data-test="invite-row"]')
    expect(rows).toHaveLength(2)
    const pendingTexts = rows[0]!.findAll('button').map((b) => b.text())
    expect(pendingTexts.some((t) => t.includes('批准'))).toBe(true)
    expect(pendingTexts.some((t) => t.includes('拒绝'))).toBe(true)
    const approvedTexts = rows[1]!.findAll('button').map((b) => b.text())
    expect(approvedTexts.some((t) => t.includes('批准'))).toBe(false)
    expect(approvedTexts.some((t) => t.includes('拒绝'))).toBe(false)
  })

  it('批准 → approveInvite(id) → 行状态翻为已批准并显示开户结果，按钮消失', async () => {
    vi.mocked(approveInvite).mockResolvedValue({ status: 'approved', email: 'alice@example.com' })
    const wrapper = mount(InvitesPage)
    await flushPromises()

    const approveBtn = wrapper.findAll('button').find((b) => b.text().includes('批准'))
    await approveBtn!.trigger('click')
    await flushPromises()

    expect(approveInvite).toHaveBeenCalledWith('tok-pending')
    expect(wrapper.text()).toContain('已批准')
    expect(wrapper.text()).toContain('已开户 alice@example.com，激活链接已发至个人邮箱')
    expect(buttonTexts(wrapper).some((t) => t.includes('批准'))).toBe(false)
  })

  it('批准结果为 null（弱化实例 · OIDC 首登者：无邮箱前缀）→ 显示个人邮箱匹配提示', async () => {
    vi.mocked(fetchInvites).mockResolvedValue([{ ...pendingInvite, email_prefix: '' }])
    vi.mocked(approveInvite).mockResolvedValue({ status: 'approved', email: null })
    const wrapper = mount(InvitesPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('批准'))!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已批准（弱化实例：首次登录按个人邮箱匹配入职）')
  })

  it('批准结果为 null（弱化实例 · 内置注册者：有邮箱前缀）→ 显示「用填表时设置的密码登录」', async () => {
    vi.mocked(approveInvite).mockResolvedValue({ status: 'approved', email: null })
    const wrapper = mount(InvitesPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('批准'))!.trigger('click')
    await flushPromises()

    // F8：内置注册者已自设密码，不存在首登匹配环节
    expect(wrapper.text()).toContain('已批准：新人用填表时设置的用户名密码登录即可')
  })

  it('批准失败 → 行内显示后端 detail 人话，状态不变', async () => {
    vi.mocked(approveInvite).mockRejectedValue(
      makeApiError(409, '请求失败（409）', 'req-9', '邮箱前缀「alice」已被占用，请改用其他前缀'),
    )
    const wrapper = mount(InvitesPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('批准'))!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('邮箱前缀「alice」已被占用，请改用其他前缀')
    expect(wrapper.text()).toContain('待审批')
    expect(buttonTexts(wrapper).some((t) => t.includes('批准'))).toBe(true)
  })

  it('拒绝：行内点「拒绝」只开站内弹层（含申请人 + 不可撤销），确认后才 rejectInvite → 状态翻为已拒绝', async () => {
    const wrapper = mount(InvitesPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('拒绝'))!.trigger('click')
    await flushPromises()

    // 站内确认替代 window.confirm（#192 F6）：确认前不发请求
    expect(window.confirm).not.toHaveBeenCalled()
    expect(rejectInvite).not.toHaveBeenCalled()
    const dialog = wrapper.find('.u-confirm')
    expect(dialog.text()).toContain('小艾')
    expect(dialog.text()).toContain('拒绝后不可撤销')

    await dialog.findAll('button').find((b) => b.text() === '拒绝')!.trigger('click')
    await flushPromises()

    expect(rejectInvite).toHaveBeenCalledWith('tok-pending')
    expect(wrapper.text()).toContain('已拒绝')
  })

  it('拒绝：弹层取消 → 不发请求，状态不变', async () => {
    const wrapper = mount(InvitesPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('拒绝'))!.trigger('click')
    await flushPromises()
    await wrapper.find('.u-confirm').findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    await flushPromises()

    expect(rejectInvite).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('待审批')
  })

  it('生成弹层：打开焦点入内 + Esc 关闭（#192 F5）', async () => {
    // attachTo：焦点断言需要 document.activeElement 生效，游离节点上 focus() 在 jsdom 里是空操作
    const wrapper = mount(InvitesPage, { attachTo: document.body })
    await flushPromises()

    const openBtn = wrapper.findAll('button').find((b) => b.text().includes('生成邀请'))!
    // jsdom 点按钮不自动聚焦，手工模拟触发元素已聚焦（与真实浏览器一致）
    ;(openBtn.element as HTMLElement).focus()
    await openBtn.trigger('click')
    await flushPromises()

    const layer = wrapper.find('[role="dialog"]')
    expect(layer.exists()).toBe(true)
    expect(layer.element.contains(document.activeElement)).toBe(true)

    await layer.trigger('keydown', { key: 'Escape' })
    await flushPromises()

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('生成：默认 7 天 → createInvite(7) → 链接与一次性提示可见', async () => {
    const wrapper = mount(InvitesPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('生成邀请'))!.trigger('click')
    await flushPromises()
    expect((wrapper.find('#invite-days').element as HTMLSelectElement).value).toBe('7')

    await wrapper.findAll('button').find((b) => b.text() === '生成')!.trigger('click')
    await flushPromises()

    expect(createInvite).toHaveBeenCalledWith(7)
    expect((wrapper.find('[data-test="invite-url"]').element as HTMLInputElement).value).toBe(
      'https://unself.example.com/invite/abc123',
    )
    expect(wrapper.text()).toContain('链接只显示一次，请立即复制并发给对方')
  })

  it('生成：改选 30 天 → createInvite(30)', async () => {
    const wrapper = mount(InvitesPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('生成邀请'))!.trigger('click')
    await wrapper.find('#invite-days').setValue('30')
    await wrapper.findAll('button').find((b) => b.text() === '生成')!.trigger('click')
    await flushPromises()

    expect(createInvite).toHaveBeenCalledWith(30)
  })

  it('生成失败 → 弹层内显示后端 detail 人话', async () => {
    vi.mocked(createInvite).mockRejectedValue(makeApiError(500, '请求失败（500）', 'req-5', '无法生成邀请：实例未配置邮箱域名'))
    const wrapper = mount(InvitesPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('生成邀请'))!.trigger('click')
    await wrapper.findAll('button').find((b) => b.text() === '生成')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('无法生成邀请：实例未配置邮箱域名')
    expect(wrapper.find('[data-test="invite-url"]').exists()).toBe(false)
  })
})
