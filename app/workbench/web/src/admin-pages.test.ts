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
  saveOidcSettings,
  saveSmtpSettings,
  saveStalwartSettings,
  setMemberStatus,
  SECRET_MASK,
  testSmtpConnection,
  testStalwartConnection,
  type InstanceSettings,
} from './lib/admin-api'
import { testOidcConnection } from './lib/setup-api'

import { resetMemberPassword } from './lib/builtin-auth-api'

/** clipboard stub（#307 复制反馈用例）：可写且记录写入内容。 */
function stubClipboard(): { writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return { writeText }
}

/**
 * 管理台行为测试（#17，docs/testing.md 两问检验）：
 * - 守卫：非 admin 访问 /admin → 重定向工作台（用户可见结果 = 路由变了）
 * - 成员页：确认停用 → 发出 disable 请求 → 徽章翻转
 * - 邀请页：批准/拒绝按钮只对 pending 出现；批准翻转行状态、拒绝先 confirm；生成链接只显示一次（#18）
 * - 设置页（#100 三行清单 + 水舱弹窗）：列表三行与描述；邮件开关直落库只发 {enabled}、失败回行级 alert、
 *   配置不全点「开」先弹窗（保存恒带 enabled:true）；弹窗按钮非成功态测试、成功态保存，
 *   「跳过测试」只在非成功态；字段再改作废测试结果、测试在途改草稿不回填；
 *   文本字段空串照发（后端删键）、密钥只有新明文才带；弹层焦点与 Esc、取消零请求、重开回初始态。
 *   #99 的「开关纯表单字段、整卡保存」已被 #100 取代。
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
  saveOidcSettings: vi.fn(),
  saveStalwartSettings: vi.fn(),
  saveSmtpSettings: vi.fn(),
  testStalwartConnection: vi.fn(),
  testSmtpConnection: vi.fn(),
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

/** 设置页夹具（#340 → #100 列表版沿用）：oidc 全量 + 两邮件段各给完整已存配置（密钥为 MASK）。 */
function settingsFixture(overrides?: {
  oidc?: Partial<InstanceSettings['oidc']>
  stalwart?: Partial<InstanceSettings['stalwart']>
  smtp?: Partial<InstanceSettings['smtp']>
}): InstanceSettings {
  return {
    oidc: { issuer: 'https://idp.example.com', clientId: 'c1', clientSecret: SECRET_MASK, scope: 'openid', ...overrides?.oidc },
    stalwart: {
      enabled: true,
      baseUrl: 'https://mail.example.com',
      apiKey: SECRET_MASK,
      domain: 'example.com',
      portalUrl: '',
      ...overrides?.stalwart,
    },
    smtp: {
      enabled: true,
      host: 'smtp.example.com',
      port: 465,
      username: 'smtp-user',
      password: SECRET_MASK,
      from: 'no-reply@example.com',
      ...overrides?.smtp,
    },
  }
}

/**
 * #100 列表形态定位纪律（#342 延续）：只认 data-test 与 input[name]，
 * 不用按钮/标题文案定位、不按行序取下标——文案与结构改版不牵连测试；
 * 水位断言走 [data-level] 属性（WaveFill 恒 aria-hidden，纯装饰不承载语义）。
 */
function settingsRow(wrapper: ReturnType<typeof mount>, domain: 'oidc' | 'stalwart' | 'smtp') {
  return wrapper.find(`[data-test="settings-row-${domain}"]`)
}
function editButton(wrapper: ReturnType<typeof mount>, domain: 'oidc' | 'stalwart' | 'smtp') {
  return wrapper.find(`[data-test="settings-edit-${domain}"]`)
}
function switchButton(wrapper: ReturnType<typeof mount>, axis: 'stalwart' | 'smtp') {
  return wrapper.find(`[data-test="settings-switch-${axis}"]`)
}
function dialogBox(wrapper: ReturnType<typeof mount>, domain: 'oidc' | 'stalwart' | 'smtp') {
  return wrapper.find(`[data-test="settings-dialog-${domain}"]`)
}
function actionButton(wrapper: ReturnType<typeof mount>, domain: 'oidc' | 'stalwart' | 'smtp') {
  return wrapper.find(`[data-test="settings-action-${domain}"]`)
}
function skipButton(wrapper: ReturnType<typeof mount>, domain: 'oidc' | 'stalwart' | 'smtp') {
  return wrapper.find(`[data-test="settings-skip-${domain}"]`)
}
/** 当前打开弹窗的水位。同一时刻至多一个弹窗在 DOM，data-level 全局唯一。 */
function waterLevel(wrapper: ReturnType<typeof mount>): string {
  return wrapper.find('[data-level]').attributes('data-level')!
}
/** 往指定 name 的输入框填值（name 是表单语义，不是测试专用钩子）。 */
async function fillInput(wrapper: ReturnType<typeof mount>, name: string, value: string): Promise<void> {
  await wrapper.find(`input[name="${name}"]`).setValue(value)
}

/** 设置页各 describe 共用的默认替身（clearAllMocks 只清调用史不清实现，逐项重设）。 */
function mockSettingsDefaults(): void {
  // 调用史清零：上一例的保存/测试调用不得泄漏到下一例的「未调用/调用次数」断言
  vi.clearAllMocks()
  vi.mocked(fetchSettings).mockResolvedValue(settingsFixture())
  vi.mocked(saveOidcSettings).mockResolvedValue({ ok: true })
  vi.mocked(saveStalwartSettings).mockResolvedValue({ ok: true })
  vi.mocked(saveSmtpSettings).mockResolvedValue({ ok: true })
  vi.mocked(testStalwartConnection).mockResolvedValue({ ok: true, detail: '已连接，域名 example.com 可用' })
  vi.mocked(testSmtpConnection).mockResolvedValue({ ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' })
}

describe('SettingsPage 列表形态（#100）', () => {
  beforeEach(mockSettingsDefaults)

  it('#100 列表三行：行标题 + 状态描述；OIDC 编辑恒显无开关；邮件两行启用态编辑 + 胶囊开关在场', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    expect(wrapper.find('[data-test="settings-list"]').exists()).toBe(true)
    expect(settingsRow(wrapper, 'oidc').text()).toContain('登录（OIDC）')
    expect(settingsRow(wrapper, 'stalwart').text()).toContain('已启用')
    expect(settingsRow(wrapper, 'smtp').text()).toContain('已启用')
    // OIDC 非能力轴：只有编辑按钮，无开关
    expect(editButton(wrapper, 'oidc').exists()).toBe(true)
    expect(wrapper.find('[data-test="settings-switch-oidc"]').exists()).toBe(false)
    // 邮件两行：启用态 → 编辑在场 + 开关 aria-checked=true
    for (const axis of ['stalwart', 'smtp'] as const) {
      expect(editButton(wrapper, axis).exists()).toBe(true)
      expect(switchButton(wrapper, axis).attributes('aria-checked')).toBe('true')
    }
    // 三卡（#340 settings-card-*）不复存在：列表形态替代
    expect(wrapper.find('[data-test="settings-card-oidc"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="settings-card-stalwart"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="settings-card-smtp"]').exists()).toBe(false)
  })

  it('#100 编辑仅启用态显示：停用（配置完整保留）→ 编辑按钮不渲染，行描述「已停用 · 配置已保留」', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(settingsFixture({ stalwart: { enabled: false } }))
    const wrapper = mount(SettingsPage)
    await flushPromises()

    expect(settingsRow(wrapper, 'stalwart').text()).toContain('已停用 · 配置已保留')
    expect(editButton(wrapper, 'stalwart').exists()).toBe(false)
    // 开关仍可切（不因停用禁用）
    expect(switchButton(wrapper, 'stalwart').attributes('aria-checked')).toBe('false')
    expect(switchButton(wrapper, 'stalwart').attributes('disabled')).toBeUndefined()
  })

  it('#100 无配置行描述 =「未配置」；开关在场恒可切、无编辑入口', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(
      settingsFixture({ stalwart: { enabled: false, baseUrl: '', apiKey: '', domain: '', portalUrl: '' } }),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    expect(settingsRow(wrapper, 'stalwart').text()).toContain('未配置')
    expect(editButton(wrapper, 'stalwart').exists()).toBe(false)
    expect(switchButton(wrapper, 'stalwart').exists()).toBe(true)
  })
})

describe('SettingsPage 开关直落库（#100）', () => {
  beforeEach(mockSettingsDefaults)

  it('#100 配置完整点开关（开→关）→ 立即 PUT {enabled:false}，不夹带字段；refetch 后行描述翻转、编辑消失', async () => {
    vi.mocked(fetchSettings)
      .mockResolvedValueOnce(settingsFixture())
      .mockResolvedValue(settingsFixture({ stalwart: { enabled: false } }))
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    // 只发 {enabled}，字段（含密钥）不夹带
    expect(saveStalwartSettings).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveStalwartSettings).mock.calls[0]![0]).toEqual({ enabled: false })
    expect(settingsRow(wrapper, 'stalwart').text()).toContain('已停用 · 配置已保留')
    expect(editButton(wrapper, 'stalwart').exists()).toBe(false)
  })

  it('#100 停用行开关切回（关→开）→ PUT {enabled:true}；refetch 后编辑按钮回归', async () => {
    vi.mocked(fetchSettings)
      .mockResolvedValueOnce(settingsFixture({ smtp: { enabled: false } }))
      .mockResolvedValue(settingsFixture())
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(saveSmtpSettings).toHaveBeenCalledWith({ enabled: true })
    expect(editButton(wrapper, 'smtp').exists()).toBe(true)
    expect(settingsRow(wrapper, 'smtp').text()).toContain('已启用')
  })

  it('#100 开关直落库失败 → 开关回滚（aria-checked 不变）+ 行级 role=alert 人话', async () => {
    vi.mocked(saveStalwartSettings).mockRejectedValueOnce(makeApiError(500, '保存失败：服务端错误'))
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(saveStalwartSettings).toHaveBeenCalledWith({ enabled: false })
    // 开关绑的是已加载值，失败后仍是开
    expect(switchButton(wrapper, 'stalwart').attributes('aria-checked')).toBe('true')
    const alert = wrapper.find('[data-test="settings-row-alert-stalwart"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('保存失败：服务端错误')
  })

  it('#100 切换在途：本轴开关禁用防双击（aria-disabled），另一轴不受牵连', async () => {
    let resolveSave!: (value: { ok: boolean }) => void
    vi.mocked(saveSmtpSettings).mockImplementation(() => new Promise((res) => { resolveSave = res }))
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(switchButton(wrapper, 'smtp').attributes('aria-disabled')).toBe('true')
    expect(switchButton(wrapper, 'stalwart').attributes('aria-disabled')).toBeUndefined()

    resolveSave({ ok: true })
    await flushPromises()
    expect(switchButton(wrapper, 'smtp').attributes('aria-disabled')).toBeUndefined()
  })
})

describe('SettingsPage 配置不全先弹窗（#100）', () => {
  beforeEach(mockSettingsDefaults)

  const emptyStalwart = {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    domain: '',
    portalUrl: '',
  } as const

  it('#100 配置不全点开开关 → 开关保持关 + 弹窗开 + 提示条「自动启用」；取消（Esc）零请求', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(settingsFixture({ stalwart: emptyStalwart }))
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    // 不发请求；开关保持关
    expect(saveStalwartSettings).not.toHaveBeenCalled()
    expect(switchButton(wrapper, 'stalwart').attributes('aria-checked')).toBe('false')
    const box = dialogBox(wrapper, 'stalwart')
    expect(box.exists()).toBe(true)
    expect(box.find('[data-test="settings-dialog-hint"]').text()).toContain('自动启用')
    expect(box.attributes('aria-label')).toContain('启用邮箱管理')

    // Esc 关闭，仍然零请求
    await box.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(dialogBox(wrapper, 'stalwart').exists()).toBe(false)
    expect(saveStalwartSettings).not.toHaveBeenCalled()
  })

  it('#100 enable-pending 跳过测试直接保存：body 恒带 enabled:true + 字段；成功后弹窗关、行翻「已启用」', async () => {
    vi.mocked(fetchSettings)
      .mockResolvedValueOnce(settingsFixture({ stalwart: emptyStalwart }))
      .mockResolvedValue(settingsFixture())
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    await fillInput(wrapper, 'stalwart-baseurl', 'https://mail.example.com')
    await fillInput(wrapper, 'stalwart-apikey', 'key-123')
    await fillInput(wrapper, 'stalwart-domain', 'example.com')
    await skipButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(testStalwartConnection).not.toHaveBeenCalled()
    expect(saveStalwartSettings).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveStalwartSettings).mock.calls[0]![0]).toEqual({
      baseUrl: 'https://mail.example.com',
      apiKey: 'key-123',
      domain: 'example.com',
      // 文本整段回写：留空的门户地址照发空串
      portalUrl: '',
      enabled: true,
    })
    // 弹窗关；refetch 后行启用，编辑按钮出现
    expect(dialogBox(wrapper, 'stalwart').exists()).toBe(false)
    expect(settingsRow(wrapper, 'stalwart').text()).toContain('已启用')
    expect(editButton(wrapper, 'stalwart').exists()).toBe(true)
  })

  it('#100 enable-pending 保存失败（D5 400 人话）→ 弹窗不关 + 弹窗内 role=alert + 开关仍关', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(settingsFixture({ stalwart: emptyStalwart }))
    vi.mocked(saveStalwartSettings).mockRejectedValueOnce(
      makeApiError(400, '请求失败（400）', 'req-9', '开启邮箱管理需先配置：Stalwart 地址、API Key、邮箱域名'),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    await fillInput(wrapper, 'stalwart-domain', 'example.com')
    await skipButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    const box = dialogBox(wrapper, 'stalwart')
    expect(box.exists()).toBe(true)
    expect(box.find('[role="alert"]').text()).toContain('开启邮箱管理需先配置')
    expect(switchButton(wrapper, 'stalwart').attributes('aria-checked')).toBe('false')
  })

  it('#100 enable-pending 完整动线：填 → 测试成功（按钮变「保存配置」）→ 保存 → 自动启用', async () => {
    vi.mocked(fetchSettings)
      .mockResolvedValueOnce(settingsFixture({ stalwart: emptyStalwart }))
      .mockResolvedValue(settingsFixture())
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    await fillInput(wrapper, 'stalwart-baseurl', 'https://mail.example.com')
    await fillInput(wrapper, 'stalwart-apikey', 'key-123')
    await fillInput(wrapper, 'stalwart-domain', 'example.com')

    // rest 态按钮是「测试连接」
    expect(actionButton(wrapper, 'stalwart').text()).toContain('测试连接')
    await actionButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    // 成功态：按钮变「保存配置」，status 在场，跳过链接退场
    expect(actionButton(wrapper, 'stalwart').text()).toContain('保存配置')
    expect(dialogBox(wrapper, 'stalwart').find('[role="status"]').text()).toContain('域名 example.com 可用')
    expect(skipButton(wrapper, 'stalwart').exists()).toBe(false)

    // 保存后自动启用
    await actionButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(saveStalwartSettings).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveStalwartSettings).mock.calls[0]![0]).toMatchObject({ enabled: true })
    expect(dialogBox(wrapper, 'stalwart').exists()).toBe(false)
    expect(settingsRow(wrapper, 'stalwart').text()).toContain('已启用')
  })
})

describe('SettingsPage 水舱动线（#100）', () => {
  beforeEach(mockSettingsDefaults)

  it('#100 填写中水位 rest（基线波动）；测试在途 → 按钮 aria-busy + 水位 testing（阈值悬停）', async () => {
    let resolveTest!: (value: { ok: boolean; detail: string }) => void
    vi.mocked(testStalwartConnection).mockImplementation(() => new Promise((res) => { resolveTest = res }))
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    // rest：基线水位，按钮未在途
    expect(waterLevel(wrapper)).toBe('rest')
    expect(actionButton(wrapper, 'stalwart').attributes('aria-busy')).toBeUndefined()

    await actionButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    // testing：水位悬停，按钮 aria-busy 且禁用
    expect(waterLevel(wrapper)).toBe('testing')
    expect(actionButton(wrapper, 'stalwart').attributes('aria-busy')).toBe('true')
    expect(actionButton(wrapper, 'stalwart').attributes('disabled')).toBeDefined()

    resolveTest({ ok: true, detail: '已连接，域名 example.com 可用' })
    await flushPromises()

    // 成功：满灌，按钮变「保存配置」，跳过链接退场
    expect(waterLevel(wrapper)).toBe('full')
    expect(actionButton(wrapper, 'stalwart').text()).toContain('保存配置')
    expect(dialogBox(wrapper, 'stalwart').find('[role="status"]').exists()).toBe(true)
    expect(skipButton(wrapper, 'stalwart').exists()).toBe(false)
  })

  it('#100 测试失败（后端 200 ok:false 人话）→ 水位回落 rest + role=alert + 按钮回「测试连接」', async () => {
    vi.mocked(testStalwartConnection).mockResolvedValue({
      ok: false,
      detail: '请先填写完整的 Stalwart 地址、API Key 与邮箱域名配置',
    })
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    await actionButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(waterLevel(wrapper)).toBe('rest')
    expect(dialogBox(wrapper, 'stalwart').find('[role="alert"]').text()).toContain('请先填写完整的 Stalwart 地址')
    expect(actionButton(wrapper, 'stalwart').text()).toContain('测试连接')
    expect(saveStalwartSettings).not.toHaveBeenCalled()
  })

  it('#100 测试异常（502）→ 同失败面：水位回落 + 后端 detail 人话', async () => {
    vi.mocked(testStalwartConnection).mockRejectedValue(
      makeApiError(502, '请求失败（502）', undefined, '邮件服务不可达：请检查 Stalwart 地址'),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    await actionButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(waterLevel(wrapper)).toBe('rest')
    expect(dialogBox(wrapper, 'stalwart').find('[role="alert"]').text()).toContain('邮件服务不可达')
  })

  it('#100 成功满灌后改字段 → 结果作废：水位回 rest、按钮回退「测试连接」、跳过链接回归', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    await actionButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    expect(waterLevel(wrapper)).toBe('full')

    await fillInput(wrapper, 'stalwart-domain', 'other.example.com')
    await flushPromises()

    expect(waterLevel(wrapper)).toBe('rest')
    expect(actionButton(wrapper, 'stalwart').text()).toContain('测试连接')
    expect(skipButton(wrapper, 'stalwart').exists()).toBe(true)
    expect(dialogBox(wrapper, 'stalwart').find('[role="status"]').exists()).toBe(false)
  })

  it('#100 测试在途改字段 → 迟到结果作废不回填（#99 竞态语义延续）', async () => {
    let resolveTest!: (value: { ok: boolean; detail: string }) => void
    vi.mocked(testStalwartConnection).mockImplementation(() => new Promise((res) => { resolveTest = res }))
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    await actionButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    // 在途改域名：这次探测对应的草稿已失效
    await fillInput(wrapper, 'stalwart-domain', 'other.example.com')
    resolveTest({ ok: true, detail: '旧草稿探测结果' })
    await flushPromises()

    expect(dialogBox(wrapper, 'stalwart').text()).not.toContain('旧草稿探测结果')
    expect(waterLevel(wrapper)).toBe('rest')
  })

  it('#100 编辑已启用轴：跳过测试直接保存 → 不调 test API、PUT 带字段与 enabled:true、弹窗关', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'smtp').trigger('click')
    await flushPromises()
    await skipButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(testSmtpConnection).not.toHaveBeenCalled()
    expect(saveSmtpSettings).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveSmtpSettings).mock.calls[0]![0]).toEqual({
      host: 'smtp.example.com',
      port: 465,
      username: 'smtp-user',
      from: 'no-reply@example.com',
      enabled: true,
    })
    expect(dialogBox(wrapper, 'smtp').exists()).toBe(false)
  })

  it('#100 测试吃当前草稿（#340 候选化保留）：改 host 后点测试 → 请求体带草稿值', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'smtp').trigger('click')
    await flushPromises()
    await fillInput(wrapper, 'smtp-host', 'smtp2.example.net')
    await actionButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(testSmtpConnection).toHaveBeenCalledWith({
      host: 'smtp2.example.net',
      port: '465',
      username: 'smtp-user',
      password: '',
      from: 'no-reply@example.com',
    })
    expect(waterLevel(wrapper)).toBe('full')
  })
})

describe('SettingsPage OIDC 弹窗（#100）', () => {
  beforeEach(mockSettingsDefaults)

  it('#100 OIDC 测试成功（含警告）→ status 行合并展示 + 按钮变「保存配置」', async () => {
    vi.mocked(testOidcConnection).mockResolvedValue({
      ok: true,
      issuer: 'https://idp.example.com',
      warnings: ['该 IdP 可能无法完成登录（不回显 nonce）'],
    })
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'oidc').trigger('click')
    await flushPromises()
    await actionButton(wrapper, 'oidc').trigger('click')
    await flushPromises()

    const box = dialogBox(wrapper, 'oidc')
    expect(box.find('[role="status"]').text()).toContain('连接成功')
    expect(box.find('[role="status"]').text()).toContain('该 IdP 可能无法完成登录')
    expect(actionButton(wrapper, 'oidc').text()).toContain('保存配置')
  })

  it('#100 OIDC 测试失败 → alert 人话 + 按钮保持「测试连接」', async () => {
    vi.mocked(testOidcConnection).mockResolvedValue({
      ok: false,
      reason: '无法访问该 Issuer：请检查地址是否正确或网络可达性',
    })
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'oidc').trigger('click')
    await flushPromises()
    await actionButton(wrapper, 'oidc').trigger('click')
    await flushPromises()

    const box = dialogBox(wrapper, 'oidc')
    expect(box.find('[role="alert"]').text()).toContain('无法访问该 Issuer')
    expect(actionButton(wrapper, 'oidc').text()).toContain('测试连接')
  })

  it('#100 OIDC 保存：只发 oidc 域字段（密钥留空不回传）；成功后弹窗关', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'oidc').trigger('click')
    await flushPromises()
    await fillInput(wrapper, 'oidc-issuer', 'https://new.example.com')
    await skipButton(wrapper, 'oidc').trigger('click')
    await flushPromises()

    expect(saveOidcSettings).toHaveBeenCalledTimes(1)
    const body = vi.mocked(saveOidcSettings).mock.calls[0]![0] as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['clientId', 'issuer', 'scope'])
    expect(body.clientSecret).toBeUndefined()
    expect(dialogBox(wrapper, 'oidc').exists()).toBe(false)
  })

  it('#100 OIDC 保存失败 → 弹窗内 role=alert、弹窗不关', async () => {
    vi.mocked(saveOidcSettings).mockRejectedValueOnce(
      makeApiError(400, '请求失败（400）', 'req-4', 'issuer 必须是合法 URL'),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'oidc').trigger('click')
    await flushPromises()
    await fillInput(wrapper, 'oidc-issuer', 'not-a-url')
    await skipButton(wrapper, 'oidc').trigger('click')
    await flushPromises()

    const box = dialogBox(wrapper, 'oidc')
    expect(box.exists()).toBe(true)
    expect(box.find('[role="alert"]').text()).toContain('issuer 必须是合法 URL')
  })
})

describe('SettingsPage 弹窗重开（#100）', () => {
  beforeEach(mockSettingsDefaults)

  it('满灌态下标题与关闭按钮仍在 DOM', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'smtp').trigger('click')
    await flushPromises()
    await actionButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(waterLevel(wrapper)).toBe('full')
    const box = dialogBox(wrapper, 'smtp')
    expect(box.find('.settings-dialog-title').text()).toContain('通知发信')
    expect(box.find('[data-test="settings-dialog-close"]').exists()).toBe(true)
  })

  it('保存成功关弹窗后重新打开 → 回到最初态（水位 rest + 按钮「测试连接」+ 无 status）', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'smtp').trigger('click')
    await flushPromises()
    await actionButton(wrapper, 'smtp').trigger('click')
    await flushPromises()
    expect(waterLevel(wrapper)).toBe('full')

    await actionButton(wrapper, 'smtp').trigger('click')
    await flushPromises()
    expect(dialogBox(wrapper, 'smtp').exists()).toBe(false)

    // 重新打开回到 rest，不停留在满灌
    await editButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(waterLevel(wrapper)).toBe('rest')
    expect(actionButton(wrapper, 'smtp').text()).toContain('测试连接')
    expect(dialogBox(wrapper, 'smtp').find('[role="status"]').exists()).toBe(false)
    expect(dialogBox(wrapper, 'smtp').find('[role="alert"]').exists()).toBe(false)
    expect(skipButton(wrapper, 'smtp').exists()).toBe(true)
  })

  it('成功态后 Esc 关闭再打开 → 同样回到最初态', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    await actionButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    expect(waterLevel(wrapper)).toBe('full')

    await dialogBox(wrapper, 'stalwart').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(dialogBox(wrapper, 'stalwart').exists()).toBe(false)

    await editButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(waterLevel(wrapper)).toBe('rest')
    expect(actionButton(wrapper, 'stalwart').text()).toContain('测试连接')
  })
})

describe('SettingsPage 清空字段（#100）', () => {
  beforeEach(mockSettingsDefaults)

  it('Stalwart 清空邮箱域名后「跳过测试，直接保存」→ body 带 domain 空串（后端据此删键清库值）', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    await fillInput(wrapper, 'stalwart-domain', '')
    await skipButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    const body = vi.mocked(saveStalwartSettings).mock.calls[0]![0] as Record<string, unknown>
    expect(body.domain).toBe('')
    expect(body.baseUrl).toBe('https://mail.example.com')
    // 密钥没填新值：不回传
    expect(body.apiKey).toBeUndefined()
    expect(body.enabled).toBe(true)
  })

  it('Stalwart 清空门户地址 → body 带 portalUrl 空串（回落按域名推导）', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(
      settingsFixture({ stalwart: { portalUrl: 'https://portal.example.com/app-passwords' } }),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    await fillInput(wrapper, 'stalwart-portal', '')
    await skipButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    const body = vi.mocked(saveStalwartSettings).mock.calls[0]![0] as Record<string, unknown>
    expect(body.portalUrl).toBe('')
  })

  it('SMTP 清空用户名后跳过测试保存 → body 带 username 空串；密码不回传', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'smtp').trigger('click')
    await flushPromises()
    await fillInput(wrapper, 'smtp-username', '')
    await skipButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    const body = vi.mocked(saveSmtpSettings).mock.calls[0]![0] as Record<string, unknown>
    expect(body.username).toBe('')
    expect(body.host).toBe('smtp.example.com')
    expect(body.port).toBe(465)
    expect(body.password).toBeUndefined()
  })

  it('SMTP 清空端口 → body 带 port 空串（后端删键 = 未配置，D5 会拦成 400 人话）', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'smtp').trigger('click')
    await flushPromises()
    await fillInput(wrapper, 'smtp-port', '')
    await skipButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    const body = vi.mocked(saveSmtpSettings).mock.calls[0]![0] as Record<string, unknown>
    expect(body.port).toBe('')
  })

  it('开关直落库路径不夹带字段（只发 {enabled}）：清空不靠开关生效', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(vi.mocked(saveSmtpSettings).mock.calls[0]![0]).toEqual({ enabled: false })
  })
})

describe('SettingsPage 弹层可达性（#100，沿用 #192 F5）', () => {
  beforeEach(mockSettingsDefaults)

  it('#100 打开焦点入内 + Esc 关闭焦点回归 + 水面恒 aria-hidden', async () => {
    const wrapper = mount(SettingsPage, { attachTo: document.body })
    await flushPromises()

    const edit = editButton(wrapper, 'oidc')
    // jsdom 点按钮不自动聚焦，手工模拟触发元素已聚焦（与真实浏览器一致）
    ;(edit.element as HTMLElement).focus()
    await edit.trigger('click')
    await flushPromises()

    const box = dialogBox(wrapper, 'oidc')
    expect(box.exists()).toBe(true)
    expect(box.element.contains(document.activeElement)).toBe(true)
    // 水面纯装饰，恒 aria-hidden
    expect(wrapper.find('[data-level]').attributes('aria-hidden')).toBe('true')

    await box.trigger('keydown', { key: 'Escape' })
    await flushPromises()

    expect(dialogBox(wrapper, 'oidc').exists()).toBe(false)
    expect(document.activeElement).toBe(edit.element)
    wrapper.unmount()
  })

  it('#100 取消不落库：弹窗内改字段后点 ✕ 关闭 → PUT/test 零调用', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await editButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    await fillInput(wrapper, 'stalwart-baseurl', 'https://changed.example.com')
    await dialogBox(wrapper, 'stalwart').find('[data-test="settings-dialog-close"]').trigger('click')
    await flushPromises()

    expect(dialogBox(wrapper, 'stalwart').exists()).toBe(false)
    expect(saveStalwartSettings).not.toHaveBeenCalled()
    expect(testStalwartConnection).not.toHaveBeenCalled()
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

  it('复制成功 → 按钮同位换「已复制」且写入剪贴板；2s 后回弹「复制」（beUI StatefulButton 模式，#307）', async () => {
    // 剪贴板 stub 先就位（用例开头），fakeTimers 后置：probe 实证 stub Clipboard 后
    // flushPromises 在 fakeTimers 下解析不出「生成」按钮，顺序换过来即稳定。
    const { writeText } = stubClipboard()
    vi.mocked(createInvite).mockResolvedValue({ inviteUrl: 'https://unself.example.com/invite/abc123' })

    vi.useFakeTimers()
    try {
      const wrapper = mount(InvitesPage)
      await flushPromises()

      await wrapper.findAll('button').find((b) => b.text().includes('生成邀请'))!.trigger('click')
      await flushPromises()

      const genBtn = wrapper.findAll('button').find((b) => b.text() === '生成')
      expect(genBtn).toBeDefined()
      await genBtn!.trigger('click')
      await flushPromises()

      const copyBtn = () => wrapper.findAll('button').find((b) => b.text() === '复制')
      expect(copyBtn()).toBeDefined()
      await copyBtn()!.trigger('click')
      await flushPromises()

      // 用户可见反馈：剪贴板确实收到链接 + 按钮同位换「已复制」
      expect(writeText).toHaveBeenCalledWith('https://unself.example.com/invite/abc123')
      expect(wrapper.text()).toContain('已复制')

      // 2s 后回弹：文案回到「复制」，可再次复制给第二个人
      await vi.advanceTimersByTimeAsync(2001)
      expect(wrapper.text()).not.toContain('已复制')
      expect(wrapper.text()).toContain('复制')
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('复制失败（剪贴板拒绝）→ 不出现「已复制」（不撒谎的反馈，#307）', async () => {
    const { writeText } = stubClipboard()
    writeText.mockRejectedValue(new Error('denied'))
    vi.mocked(createInvite).mockResolvedValue({ inviteUrl: 'https://unself.example.com/invite/abc123' })
    const wrapper = mount(InvitesPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text().includes('生成邀请'))!.trigger('click')
    await flushPromises()
    await wrapper.findAll('button').find((b) => b.text() === '生成')!.trigger('click')
    await flushPromises()
    await wrapper.findAll('button').find((b) => b.text() === '复制')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('已复制')
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
