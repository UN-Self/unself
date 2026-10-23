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
 * - 成员页：confirm 停用 → 发出 disable 请求 → 徽章翻转
 * - 邀请页：批准/拒绝按钮只对 pending 出现；批准翻转行状态、拒绝先 confirm；生成链接只显示一次（#18）
 * - 设置页（#340 三卡）：各卡独立保存只发改动字段（密钥留空不回传）；测试连接发未保存草稿；
 *   本卡字段变更丢弃本卡测试结果；开关切换不发请求（#159），点本卡保存才落库；
 *   配置区常显、测试恒可用、开关恒可切（#99 动线：开→填→测→存任意顺序）
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

/** #340 三卡分域后的设置页夹具：oidc 全量 + 两邮件段各给完整已存配置（密钥为 MASK）。 */
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
 * #340 设置页定位纪律（#342 评审定案）：只认 data-test 与 input[name]，
 * 不用按钮/标题文案定位、不按卡序/输入序取下标——文案与结构改版不牵连测试。
 */
function settingsCard(wrapper: ReturnType<typeof mount>, domain: 'oidc' | 'stalwart' | 'smtp') {
  return wrapper.find(`[data-test="settings-card-${domain}"]`)
}
function saveButton(wrapper: ReturnType<typeof mount>, domain: 'oidc' | 'stalwart' | 'smtp') {
  return wrapper.find(`[data-test="settings-save-${domain}"]`)
}
function testButton(wrapper: ReturnType<typeof mount>, domain: 'oidc' | 'stalwart' | 'smtp') {
  return wrapper.find(`[data-test="settings-test-${domain}"]`)
}
function switchButton(wrapper: ReturnType<typeof mount>, axis: 'stalwart' | 'smtp') {
  return wrapper.find(`[data-test="settings-switch-${axis}"]`)
}
/** 往指定 name 的输入框填值（name 是表单语义，不是测试专用钩子）。 */
async function fillInput(wrapper: ReturnType<typeof mount>, name: string, value: string): Promise<void> {
  await wrapper.find(`input[name="${name}"]`).setValue(value)
}

describe('SettingsPage 保存与测试连接（#340 三卡分域）', () => {
  beforeEach(() => {
    // 调用史清零：上一例的保存/测试调用不得泄漏到下一例的「调用次数」断言
    vi.clearAllMocks()
    vi.mocked(fetchSettings).mockResolvedValue(settingsFixture())
    vi.mocked(saveOidcSettings).mockResolvedValue({ ok: true })
    vi.mocked(saveStalwartSettings).mockResolvedValue({ ok: true })
    vi.mocked(saveSmtpSettings).mockResolvedValue({ ok: true })
    vi.mocked(testStalwartConnection).mockResolvedValue({ ok: true, detail: '已连接，域名 example.com 可用' })
    vi.mocked(testSmtpConnection).mockResolvedValue({ ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' })
  })

  it('#340 三卡各自独立保存：只点 SMTP 卡「保存」→ 仅 PUT mail-smtp 被调用，无其他 PUT', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await saveButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(saveSmtpSettings).toHaveBeenCalledTimes(1)
    expect(saveOidcSettings).not.toHaveBeenCalled()
    expect(saveStalwartSettings).not.toHaveBeenCalled()
    // 保存成功的可见结果收敛到本卡作用域（多卡同构，全局匹配会遮住「错误落到他卡」的回归）
    expect(settingsCard(wrapper, 'smtp').text()).toContain('已保存')
  })

  it('#340 OIDC 保存只发 oidc 域字段（无 mail/stalwart/smtp 键），另两张卡 PUT 零调用', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await fillInput(wrapper, 'oidc-issuer', 'https://new.example.com')
    await saveButton(wrapper, 'oidc').trigger('click')
    await flushPromises()

    expect(saveOidcSettings).toHaveBeenCalledTimes(1)
    const body = vi.mocked(saveOidcSettings).mock.calls[0]![0] as Record<string, unknown>
    // 只发 oidc 域字段；密钥留空绝不回传
    expect(Object.keys(body).sort()).toEqual(['clientId', 'issuer', 'scope'])
    expect(body.clientSecret).toBeUndefined()
    // 不夹带任何邮件字段（#340：历史 body 的 mail 键不复存在）
    expect(body.mail).toBeUndefined()
    expect(body.stalwart).toBeUndefined()
    expect(body.smtp).toBeUndefined()
    expect(saveStalwartSettings).not.toHaveBeenCalled()
    expect(saveSmtpSettings).not.toHaveBeenCalled()
  })

  it('保存：密钥留空 → 各卡 PUT body 不含密钥字段，只发改动/非空字段', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    // OIDC 卡：改 issuer 保存
    await fillInput(wrapper, 'oidc-issuer', 'https://new.example.com')
    await saveButton(wrapper, 'oidc').trigger('click')
    await flushPromises()

    // Stalwart 卡：不改任何字段直接保存（合并语义：非空字段全量回传，密钥绝不出现）
    await saveButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    const stalwartBody = vi.mocked(saveStalwartSettings).mock.calls[0]![0] as Record<string, unknown>
    expect(stalwartBody.baseUrl).toBe('https://mail.example.com')
    expect(stalwartBody.domain).toBe('example.com')
    expect(stalwartBody.apiKey).toBeUndefined()
    // 各卡保存成功的可见结果各归各卡（OIDC 卡保存过、Stalwart 卡也保存过）
    expect(settingsCard(wrapper, 'oidc').text()).toContain('已保存')
    expect(settingsCard(wrapper, 'stalwart').text()).toContain('已保存')
  })

  it('#184：填了邮箱门户地址 → Stalwart PUT 带 portalUrl；清空 → PUT 带空串（后端清覆盖、回落推导）', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    // 填值保存：PUT 里出现 portalUrl
    await fillInput(wrapper, 'stalwart-portal', 'https://portal.example.com/app-passwords')
    await saveButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    expect(saveStalwartSettings).toHaveBeenCalledWith(
      expect.objectContaining({ portalUrl: 'https://portal.example.com/app-passwords' }),
    )

    // 清空再保存：空串（= 让后端删掉覆盖键、回落按域名推导），不是「不发该字段」
    vi.mocked(saveStalwartSettings).mockClear()
    await fillInput(wrapper, 'stalwart-portal', '')
    await saveButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    expect(saveStalwartSettings).toHaveBeenCalledWith(expect.objectContaining({ portalUrl: '' }))
  })

  it('测试连接成功 + IdP 缺 nonce → 黄牌警告可见', async () => {
    vi.mocked(testOidcConnection).mockResolvedValue({
      ok: true,
      issuer: 'https://idp.example.com',
      warnings: ['该 IdP 可能无法完成登录（不回显 nonce）'],
    })
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const testBtn = testButton(wrapper, 'oidc')
    await testBtn.trigger('click')
    await flushPromises()

    expect(settingsCard(wrapper, 'oidc').text()).toContain('连接成功')
    expect(settingsCard(wrapper, 'oidc').text()).toContain('该 IdP 可能无法完成登录（不回显 nonce）')
  })

  it('测试连接失败 → 人话原因可见（不显示成功）', async () => {
    vi.mocked(testOidcConnection).mockResolvedValue({ ok: false, reason: '无法访问该 Issuer：请检查地址是否正确或网络可达性' })
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const testBtn = testButton(wrapper, 'oidc')
    await testBtn.trigger('click')
    await flushPromises()

    expect(settingsCard(wrapper, 'oidc').text()).toContain('无法访问该 Issuer')
    expect(settingsCard(wrapper, 'oidc').text()).not.toContain('连接成功')
  })

  it('#340 未保存草稿测试：改 SMTP host 后点本卡测试 → 请求体带草稿值不是已存值', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await fillInput(wrapper, 'smtp-host', 'smtp2.example.net')
    await testButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(testSmtpConnection).toHaveBeenCalledTimes(1)
    // 草稿全量发出：改动字段带草稿值，未改字段带当前表单值；密钥留空原样传 ''（后端回退已存值）
    expect(testSmtpConnection).toHaveBeenCalledWith({
      host: 'smtp2.example.net',
      port: '465',
      username: 'smtp-user',
      password: '',
      from: 'no-reply@example.com',
    })
  })

  it('#340 未保存草稿测试：Stalwart 卡不动任何字段点测试 → 草稿原样发当前表单值（密钥留空发空串，不发明文）', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await testButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(testStalwartConnection).toHaveBeenCalledTimes(1)
    expect(testStalwartConnection).toHaveBeenCalledWith({
      baseUrl: 'https://mail.example.com',
      apiKey: '',
      domain: 'example.com',
    })
  })

  it('#340 本卡字段变更 → 本卡旧测试结果消失（结果区移除）；他卡测试结果不受影响', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    // 两张邮件卡各测一次，结果各归各卡（结果断言都收敛到卡内作用域）
    const stalwartCard = settingsCard(wrapper, 'stalwart')
    const smtpCard = settingsCard(wrapper, 'smtp')
    await testButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    await testButton(wrapper, 'smtp').trigger('click')
    await flushPromises()
    expect(stalwartCard.text()).toContain('域名 example.com 可用')
    expect(smtpCard.text()).toContain('未投递邮件')

    // 改 SMTP host：只清 SMTP 卡结果；Stalwart 卡结果保留
    await fillInput(wrapper, 'smtp-host', 'smtp2.example.net')
    await flushPromises()
    expect(smtpCard.text()).not.toContain('未投递邮件')
    expect(stalwartCard.text()).toContain('域名 example.com 可用')

    // 改 Stalwart 域名：Stalwart 卡结果也消失
    await fillInput(wrapper, 'stalwart-domain', 'other.example.com')
    await flushPromises()
    expect(stalwartCard.text()).not.toContain('域名 example.com 可用')
  })

  it('#340 Stalwart 测试失败（#139）→ 错误文案只在邮箱管理卡内，不落在其他卡', async () => {
    vi.mocked(testStalwartConnection).mockRejectedValue(
      makeApiError(502, '请求失败（502）', undefined, '邮件服务不可达：请检查 Stalwart 地址'),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await testButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    const stalwartCard = settingsCard(wrapper, 'stalwart')
    expect(stalwartCard.text()).toContain('邮件服务不可达')
    expect(stalwartCard.find('[role="alert"]').exists()).toBe(true)
    expect(settingsCard(wrapper, 'oidc').find('[role="alert"]').exists()).toBe(false)
    expect(settingsCard(wrapper, 'smtp').find('[role="alert"]').exists()).toBe(false)
    expect(settingsCard(wrapper, 'oidc').text()).not.toContain('邮件服务不可达')
    expect(settingsCard(wrapper, 'smtp').text()).not.toContain('邮件服务不可达')
  })

  it('#340 OIDC 测试与邮件卡测试互不影响（#139）→ loading 独立，结果各归各卡', async () => {
    let resolveOidc!: (v: { ok: true; issuer: string; warnings: string[] }) => void
    vi.mocked(testOidcConnection).mockImplementation(
      () => new Promise((res) => { resolveOidc = res }),
    )
    vi.mocked(testSmtpConnection).mockResolvedValue({ ok: true, detail: 'SMTP 通了' })
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const oidcBtn = testButton(wrapper, 'oidc')
    const smtpBtn = testButton(wrapper, 'smtp')

    await oidcBtn.trigger('click')
    await flushPromises()
    // OIDC 在途转圈，SMTP 测试按钮不受牵连（aria-busy = 可访问性树上的在途态）
    expect(oidcBtn.attributes('aria-busy')).toBe('true')
    expect(smtpBtn.attributes('aria-busy')).toBeUndefined()

    await smtpBtn.trigger('click')
    await flushPromises()
    // SMTP 测试完成，结果在 SMTP 卡内；OIDC 仍在途、无结果
    expect(settingsCard(wrapper, 'smtp').text()).toContain('SMTP 通了')
    expect(settingsCard(wrapper, 'oidc').text()).not.toContain('连接成功')
    expect(oidcBtn.attributes('aria-busy')).toBe('true')

    resolveOidc({ ok: true, issuer: 'https://idp.example.com', warnings: [] })
    await flushPromises()
    expect(settingsCard(wrapper, 'oidc').text()).toContain('连接成功')
    // SMTP 结果不被 OIDC 结果冲掉
    expect(settingsCard(wrapper, 'smtp').text()).toContain('SMTP 通了')
  })

  it('#340 保存失败 → 后端 400 detail 人话在本卡 role=alert 可见（不触发本卡「已保存」），他卡不受影响', async () => {
    vi.mocked(saveSmtpSettings).mockRejectedValueOnce(
      makeApiError(400, '请求失败（400）', 'req-4', '开启通知发信需先配置：port'),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await saveButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    const smtpCard = settingsCard(wrapper, 'smtp')
    expect(smtpCard.find('[role="alert"]').text()).toContain('开启通知发信需先配置：port')
    expect(smtpCard.text()).not.toContain('已保存')
    expect(settingsCard(wrapper, 'oidc').find('[role="alert"]').exists()).toBe(false)
    expect(settingsCard(wrapper, 'stalwart').find('[role="alert"]').exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SettingsPage 邮件两卡开关（#340：enabled 可操作化，卡粒度 #159 表单语义）
// ---------------------------------------------------------------------------

describe('SettingsPage 邮件卡开关（#340 两卡版）', () => {
  beforeEach(() => {
    // 保存 mock 是模块级共享的：清掉前序用例的调用痕迹（「未调用」断言才可信）
    vi.clearAllMocks()
    vi.mocked(fetchSettings).mockResolvedValue(settingsFixture())
    vi.mocked(saveOidcSettings).mockResolvedValue({ ok: true })
    vi.mocked(saveStalwartSettings).mockResolvedValue({ ok: true })
    vi.mocked(saveSmtpSettings).mockResolvedValue({ ok: true })
    // 测试连接默认实现：clearAllMocks 只清调用史、不清实现，前序用例的在途替身会泄漏过来
    vi.mocked(testStalwartConnection).mockResolvedValue({ ok: true, detail: '已连接，域名 example.com 可用' })
    vi.mocked(testSmtpConnection).mockResolvedValue({ ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' })
  })

  it('#99/#159 表单语义（邮箱管理卡）：切换开关不发请求（配置区常显、保持可编辑），点本卡「保存」才落库 enabled=false', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const sw = switchButton(wrapper, 'stalwart')
    expect(sw.attributes('aria-checked')).toBe('true')

    await sw.trigger('click')
    await flushPromises()

    // 切换不发请求；表单常显（#99）：配置区不存在折叠态——输入仍可编辑、无 inert/aria-hidden
    expect(saveStalwartSettings).not.toHaveBeenCalled()
    expect(switchButton(wrapper, 'stalwart').attributes('aria-checked')).toBe('false')
    const config = wrapper.find('[data-test="stalwart-config"]')
    expect(config.attributes('inert')).toBeUndefined()
    expect(config.attributes('aria-hidden')).toBeUndefined()
    expect(config.find('input[name="stalwart-baseurl"]').exists()).toBe(true)

    // 本卡保存 → enabled 随字段一次落库（关≠清配置：密钥字段绝不回传）
    await saveButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(saveStalwartSettings).toHaveBeenCalledTimes(1)
    const body = vi.mocked(saveStalwartSettings).mock.calls[0]![0] as Record<string, unknown>
    expect(body.enabled).toBe(false)
    expect(body.apiKey).toBeUndefined()
  })

  it('#99/#159 表单语义（SMTP 卡）：切换开关不发请求（配置区常显、保持可编辑），点本卡「保存」才落库 enabled=false；他卡 PUT 零调用', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const sw = switchButton(wrapper, 'smtp')
    expect(sw.attributes('aria-checked')).toBe('true')

    await sw.trigger('click')
    await flushPromises()

    expect(saveSmtpSettings).not.toHaveBeenCalled()
    expect(switchButton(wrapper, 'smtp').attributes('aria-checked')).toBe('false')
    const config = wrapper.find('[data-test="smtp-config"]')
    expect(config.attributes('inert')).toBeUndefined()
    expect(config.attributes('aria-hidden')).toBeUndefined()
    expect(config.find('input[name="smtp-host"]').exists()).toBe(true)

    await saveButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(saveSmtpSettings).toHaveBeenCalledTimes(1)
    const body = vi.mocked(saveSmtpSettings).mock.calls[0]![0] as Record<string, unknown>
    expect(body.enabled).toBe(false)
    expect(body.password).toBeUndefined()
    // 卡独立性：只点了 SMTP 保存，另两卡零请求
    expect(saveOidcSettings).not.toHaveBeenCalled()
    expect(saveStalwartSettings).not.toHaveBeenCalled()
  })

  it('#99 关闭态：两卡配置区常显可编辑 + 测试按钮不再禁用 + 关态提示在场', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'stalwart').trigger('click')
    await switchButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    for (const key of ['stalwart-config', 'smtp-config'] as const) {
      const config = wrapper.find(`[data-test="${key}"]`)
      expect(config.exists()).toBe(true)
      expect(config.attributes('inert')).toBeUndefined()
      expect(config.attributes('aria-hidden')).toBeUndefined()
    }
    // #99 测试恒可用：轴关着也能测（候选化探测不依赖开关状态）
    expect(testButton(wrapper, 'stalwart').attributes('disabled')).toBeUndefined()
    expect(testButton(wrapper, 'smtp').attributes('disabled')).toBeUndefined()
    // 关态提示（状态切换后的可见结果）：收敛为关键词，不锁整句文案
    const stalwartCard = settingsCard(wrapper, 'stalwart')
    const smtpCard = settingsCard(wrapper, 'smtp')
    expect(stalwartCard.text()).toContain('不再开户')
    expect(smtpCard.text()).toContain('不再发送通知邮件')
  })

  it('#99 全链路动线（SMTP 卡）：关 → 填 → 测试 → 保存，PUT 恒带 enabled', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(
      settingsFixture({ smtp: { enabled: false } }),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    // ① 开：开关纯表单字段，恒可切（不发请求）
    await switchButton(wrapper, 'smtp').trigger('click')
    await flushPromises()
    expect(saveSmtpSettings).not.toHaveBeenCalled()

    // ② 填：改 host 为新草稿值
    await fillInput(wrapper, 'smtp-host', 'smtp2.example.net')

    // ③ 测试：轴关着照样能测，吃的是当前草稿
    await testButton(wrapper, 'smtp').trigger('click')
    await flushPromises()
    expect(testSmtpConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp2.example.net' }),
    )
    expect(settingsCard(wrapper, 'smtp').text()).toContain('未投递邮件')

    // ④ 保存：开关 + 字段一次落库
    await saveButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(saveSmtpSettings).toHaveBeenCalledTimes(1)
    const body = vi.mocked(saveSmtpSettings).mock.calls[0]![0] as Record<string, unknown>
    expect(body.enabled).toBe(true)
    expect(body.host).toBe('smtp2.example.net')
    expect(body.password).toBeUndefined()
    expect(settingsCard(wrapper, 'smtp').text()).toContain('已保存')
  })

  it('#99 空保存幂等（全新实例无配置）：enabled 恒携带——只发 {enabled:false}，不夹带任何字段', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(
      settingsFixture({ stalwart: { enabled: false, baseUrl: '', apiKey: '', domain: '', portalUrl: '' } }),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    // 什么都不填、开关保持关 → 点保存：body 仍必须是合法对象（enabled 必填，缺了后端 400）
    await saveButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(saveStalwartSettings).toHaveBeenCalledWith({ enabled: false })
    expect(settingsCard(wrapper, 'stalwart').text()).toContain('已保存')
  })

  it('#99 全新实例开开关即存：body {enabled:true} → 后端 D5 人话 detail 可见（不是 zod 机器文案）', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(
      settingsFixture({ stalwart: { enabled: false, baseUrl: '', apiKey: '', domain: '', portalUrl: '' } }),
    )
    vi.mocked(saveStalwartSettings).mockRejectedValueOnce(
      makeApiError(400, '请求失败（400）', 'req-9', '开启邮箱管理需先配置：Stalwart 地址、API Key、邮箱域名'),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'stalwart').trigger('click')
    await saveButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(saveStalwartSettings).toHaveBeenCalledWith({ enabled: true })
    const card = settingsCard(wrapper, 'stalwart')
    expect(card.find('[role="alert"]').text()).toContain('开启邮箱管理需先配置')
    expect(card.text()).not.toContain('已保存')
  })

  it('#99 测试在途改字段 → 迟到结果作废，不回填本卡（#340 竞态面）', async () => {
    let resolveTest!: (value: { ok: boolean; detail: string }) => void
    vi.mocked(testStalwartConnection).mockImplementation(
      () => new Promise((res) => { resolveTest = res }),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await testButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()
    // 在途：改域名形成新草稿，探测结果对应的是旧草稿
    await fillInput(wrapper, 'stalwart-domain', 'other.example.com')

    resolveTest({ ok: true, detail: '旧草稿探测结果' })
    await flushPromises()

    expect(settingsCard(wrapper, 'stalwart').text()).not.toContain('旧草稿探测结果')
  })

  it('#340 卡级隔离：保存只在被点的那张卡显示「已保存」，另两卡不显示', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await saveButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(settingsCard(wrapper, 'smtp').text()).toContain('已保存')
    expect(settingsCard(wrapper, 'oidc').text()).not.toContain('已保存')
    expect(settingsCard(wrapper, 'stalwart').text()).not.toContain('已保存')
  })

  it('#340 卡级隔离：保存在途只转本卡按钮（aria-busy），另两卡保持空闲', async () => {
    let resolveSave!: (value: { ok: boolean }) => void
    vi.mocked(saveSmtpSettings).mockImplementation(
      () => new Promise((res) => { resolveSave = res }),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await saveButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(saveButton(wrapper, 'smtp').attributes('aria-busy')).toBe('true')
    expect(saveButton(wrapper, 'oidc').attributes('aria-busy')).toBeUndefined()
    expect(saveButton(wrapper, 'stalwart').attributes('aria-busy')).toBeUndefined()

    resolveSave({ ok: true })
    await flushPromises()
    expect(saveButton(wrapper, 'smtp').attributes('aria-busy')).toBeUndefined()
  })

  it('#340 密钥写入正路径：三卡填密钥保存 → body 带新值；保存后输入清空、「已配置」提示翻转', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(
      settingsFixture({ oidc: { clientSecret: '' }, stalwart: { apiKey: '' }, smtp: { password: '' } }),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    // 保存前：三卡密钥均「尚未配置」
    for (const card of ['oidc', 'stalwart', 'smtp'] as const) {
      expect(settingsCard(wrapper, card).text()).toContain('尚未配置')
    }

    const secrets = [
      { card: 'oidc', name: 'oidc-client-secret', value: 'new-client-secret' },
      { card: 'stalwart', name: 'stalwart-apikey', value: 'new-api-key' },
      { card: 'smtp', name: 'smtp-password', value: 'new-smtp-pass' },
    ] as const
    for (const secret of secrets) {
      await fillInput(wrapper, secret.name, secret.value)
      await saveButton(wrapper, secret.card).trigger('click')
      await flushPromises()
    }

    // 各卡 PUT body 都带上新密钥（只写不读：GET 永远是 ***）
    expect(vi.mocked(saveOidcSettings).mock.calls[0]![0]).toMatchObject({ clientSecret: 'new-client-secret' })
    expect(vi.mocked(saveStalwartSettings).mock.calls[0]![0]).toMatchObject({ apiKey: 'new-api-key' })
    expect(vi.mocked(saveSmtpSettings).mock.calls[0]![0]).toMatchObject({ password: 'new-smtp-pass' })

    // 保存后输入清空（不回显真值），提示翻「已配置」
    for (const secret of secrets) {
      expect((wrapper.find(`input[name="${secret.name}"]`).element as HTMLInputElement).value).toBe('')
      expect(settingsCard(wrapper, secret.card).text()).toContain('已配置')
    }
  })

  it('#99 关态直测（邮箱管理卡）：轴关着直接点测试 → 请求照发、结果落在本卡', async () => {
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(testButton(wrapper, 'stalwart').attributes('disabled')).toBeUndefined()
    await testButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(testStalwartConnection).toHaveBeenCalledTimes(1)
    expect(settingsCard(wrapper, 'stalwart').text()).toContain('域名 example.com 可用')
  })

  it('#99 无邮箱管理行（全字段空）→ 开关恒可切；开 → 填 → 存一步到位（PUT 带 enabled:true）', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(
      settingsFixture({
        stalwart: { enabled: false, baseUrl: '', apiKey: '', domain: '', portalUrl: '' },
      }),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const sw = switchButton(wrapper, 'stalwart')
    expect(sw.attributes('aria-checked')).toBe('false')
    // #99：无「无配置 disabled」守卫——开关恒可切
    expect(sw.attributes('disabled')).toBeUndefined()
    await sw.trigger('click')
    expect(switchButton(wrapper, 'stalwart').attributes('aria-checked')).toBe('true')
    expect(saveStalwartSettings).not.toHaveBeenCalled()

    // 配置区常显可编辑、测试恒可用
    const config = wrapper.find('[data-test="stalwart-config"]')
    expect(config.find('input[name="stalwart-baseurl"]').exists()).toBe(true)
    expect(testButton(wrapper, 'stalwart').attributes('disabled')).toBeUndefined()

    // 填写并本卡保存 → 创建行且带 enabled（表单语义：开关值随保存落库）
    await fillInput(wrapper, 'stalwart-baseurl', 'https://mail.example.com')
    await saveButton(wrapper, 'stalwart').trigger('click')
    await flushPromises()

    expect(saveStalwartSettings).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveStalwartSettings).mock.calls[0]![0]).toEqual({
      baseUrl: 'https://mail.example.com',
      enabled: true,
    })
  })

  it('#99 无 SMTP 行 → 开关可切、配置区常显；填 → 存只发 mail-smtp PUT（两键互不产生）', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(
      settingsFixture({
        smtp: { enabled: false, host: '', port: '', username: '', password: '', from: '' },
      }),
    )
    const wrapper = mount(SettingsPage)
    await flushPromises()

    const sw = switchButton(wrapper, 'smtp')
    expect(sw.attributes('aria-checked')).toBe('false')
    expect(sw.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-test="smtp-config"]').find('input[name="smtp-host"]').exists()).toBe(true)

    await fillInput(wrapper, 'smtp-host', 'smtp.example.com')
    await saveButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    expect(saveSmtpSettings).toHaveBeenCalledTimes(1)
    expect(saveStalwartSettings).not.toHaveBeenCalled()
  })

  it('保存失败 → 后端 detail/message 人话在本卡 role=alert（不触发本卡「已保存」）；开关保持用户所选（本地表单态，未落库）', async () => {
    vi.mocked(saveSmtpSettings).mockRejectedValueOnce(makeApiError(500, '保存失败：服务端错误'))
    const wrapper = mount(SettingsPage)
    await flushPromises()

    await switchButton(wrapper, 'smtp').trigger('click')
    await flushPromises()
    expect(switchButton(wrapper, 'smtp').attributes('aria-checked')).toBe('false')

    await saveButton(wrapper, 'smtp').trigger('click')
    await flushPromises()

    const smtpCard = settingsCard(wrapper, 'smtp')
    expect(smtpCard.find('[role="alert"]').text()).toContain('保存失败：服务端错误')
    expect(smtpCard.text()).not.toContain('已保存')
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
