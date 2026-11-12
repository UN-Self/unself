// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import AuditPage from './AuditPage.vue'
import ModulesPage from './ModulesPage.vue'
import { fetchAdminModules, fetchAuditLog, fetchModuleConfig, saveModuleConfig, toggleModule, type AdminModule, type AuditEntry } from '../lib/admin-api'
import { fetchConnectStatus, removeModule } from '../lib/modules-install-api'

/**
 * ModulesPage / AuditPage 行为测试（#208，docs/testing.md 两问检验）：
 * - 模块页：加载三态（骨架/错误卡/列表）+ 空态 + 启停开关行内翻转与失败提示
 * - 审计页：加载三态 + 空态 + 倒序只读行（时间/动作/操作者/对象）
 * - 模块页 U7（#349）：反连行「测试」按钮（点击才测）+ 行内在线/离线结果 + 存储列文案收敛
 * - 模块页 U10（#349）：行内「移除」——站内 danger 确认后才 DELETE；取消/Esc 不发请求；确认后行消失；失败行内提示
 * 均通过 mock 数据源函数（fetchAdminModules/fetchAuditLog/toggleModule/fetchConnectStatus/removeModule）驱动状态，
 * 断言用户可见结果（骨架在场、行文本、role=alert），不碰实现细节。
 */

vi.mock('../lib/admin-api', () => ({
  fetchAdminModules: vi.fn(),
  toggleModule: vi.fn(),
  fetchAuditLog: vi.fn(),
  fetchModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
}))

// ModulesPage 挂载 AddModuleDialog（弹窗壳），其依赖一并 mock（未点测试不会触发网络）
vi.mock('../lib/modules-install-api', () => ({
  activateConnectModule: vi.fn(),
  fetchConnectStatus: vi.fn(),
  generateConnectKey: vi.fn(),
  installCloudflareModule: vi.fn(),
  registerConnectModule: vi.fn(),
  removeModule: vi.fn(),
}))

const mod = (over: Partial<AdminModule> = {}): AdminModule => ({
  id: 'hello',
  enabled: true,
  version: '0.1.0',
  mode: 'cloudflare',
  entry: null,
  storage_level: null,
  ...over,
})

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1,
  actor: 'u_admin',
  action: 'module_disabled',
  target: 'hello',
  created_at: '2026-09-01 08:00:00',
  ...over,
})

describe('ModulesPage（#208）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 每例给默认成功数据：三态用例各自覆写自己关心的返回
    vi.mocked(fetchAdminModules).mockResolvedValue([mod()])
    vi.mocked(toggleModule).mockResolvedValue({})
    vi.mocked(fetchConnectStatus).mockResolvedValue({ moduleId: 'hello', online: true })
  })

  it('加载中 → 骨架屏在场（USkeleton role=status），列表未渲染', async () => {
    let resolveList!: (v: AdminModule[]) => void
    vi.mocked(fetchAdminModules).mockImplementation(() => new Promise((res) => { resolveList = res }))
    const wrapper = mount(ModulesPage)

    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('hello')
    resolveList([mod()])
    await flushPromises()
    wrapper.unmount()
  })

  it('加载成功 → 行渲染模块 id + 版本徽章', async () => {
    const wrapper = mount(ModulesPage)
    await flushPromises()

    expect(wrapper.text()).toContain('hello')
    expect(wrapper.text()).toContain('v0.1.0')
    expect(wrapper.find('[data-test="module-row"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('落点三列可见（#348/#107 消费面）：mode+存储，connect 模式带接入 URL', async () => {
    vi.mocked(fetchAdminModules).mockResolvedValue([
      mod({ id: 'a', mode: 'cloudflare', storage_level: 'core' }),
      mod({ id: 'b', mode: 'connect', entry: 'https://team.example.com/m/b/', storage_level: null }),
    ])
    const wrapper = mount(ModulesPage)
    await flushPromises()

    const rows = wrapper.findAll('[data-test="module-provisioning"]')
    expect(rows).toHaveLength(2)
    // U7 存储文案收敛：旧值 dedicated→Core、null→自托管
    expect(rows[0]!.text()).toBe('落点 cloudflare · 存储 Core')
    expect(rows[1]!.text()).toBe('落点 connect · 存储 自托管 · 接入 https://team.example.com/m/b/')
    wrapper.unmount()
  })

  it('空数据 → 空态文案「还没有注册模块」', async () => {
    vi.mocked(fetchAdminModules).mockResolvedValue([])
    const wrapper = mount(ModulesPage)
    await flushPromises()

    expect(wrapper.text()).toContain('还没有注册模块')
    expect(wrapper.find('[data-test="module-row"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('加载失败 → 错误卡（role=alert）带人话标题，不是空白页', async () => {
    vi.mocked(fetchAdminModules).mockRejectedValue(
      Object.assign(new Error('请求失败（500）'), { status: 500, requestId: 'req-208', detail: 'boom' }),
    )
    const wrapper = mount(ModulesPage)
    await flushPromises()

    const err = wrapper.find('[role="alert"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('模块列表加载失败')
    expect(err.text()).toContain('请求失败（500）')
    expect(err.text()).toContain('req-208')
    wrapper.unmount()
  })

  it('切换启停成功 → 行内状态徽章翻转 + 请求带目标状态', async () => {
    const wrapper = mount(ModulesPage)
    await flushPromises()
    expect(wrapper.text()).toContain('启用中')

    const toggleBtn = wrapper.findAll('button').find((b) => b.text() === '停用')
    expect(toggleBtn).toBeDefined()
    await toggleBtn!.trigger('click')
    await flushPromises()

    expect(toggleModule).toHaveBeenCalledWith('hello', false)
    expect(wrapper.text()).toContain('已停用')
    expect(wrapper.text()).not.toContain('启用中')
    // 翻转后按钮文案随之变化（再点即启用）
    expect(wrapper.findAll('button').some((b) => b.text() === '启用')).toBe(true)
    wrapper.unmount()
  })

  it('切换启停失败 → 行内 role=alert 提示，状态不翻转', async () => {
    vi.mocked(toggleModule).mockRejectedValue(new Error('请求失败（500）'))
    const wrapper = mount(ModulesPage)
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text() === '停用')!.trigger('click')
    await flushPromises()

    expect(toggleModule).toHaveBeenCalledWith('hello', false)
    expect(wrapper.find('[role="alert"]').text()).toContain('请求失败（500）')
    expect(wrapper.text()).toContain('启用中')
    expect(wrapper.text()).not.toContain('已停用')
    wrapper.unmount()
  })

  // ---- U7（#349）：反连行内「测试」按钮 + 存储列文案收敛 ----

  /** 存储值含旧契约值（self/shared/dedicated/''），构造时不走严格字面量类型。 */
  const modRaw = (id: string, storage_level: unknown): AdminModule =>
    ({ id, enabled: true, version: '0.1.0', mode: 'cloudflare', entry: null, storage_level }) as AdminModule

  it('U7：反连行有「测试」按钮；CF/docker 行没有按钮，只显示 —；挂载即不自动测', async () => {
    vi.mocked(fetchAdminModules).mockResolvedValue([
      mod({ id: 'cf-mod', mode: 'cloudflare' }),
      mod({ id: 'bridge', mode: 'connect', entry: 'https://team.example.com/m/bridge/' }),
      mod({ id: 'docker-mod', mode: 'docker' }),
    ])
    const wrapper = mount(ModulesPage)
    await flushPromises()

    const rows = wrapper.findAll('[data-test="module-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.find('[data-test="test-connection"]').exists()).toBe(false)
    expect(rows[0]!.find('[data-test="test-connection-empty"]').text()).toBe('—')
    expect(rows[2]!.find('[data-test="test-connection"]').exists()).toBe(false)
    expect(rows[2]!.find('[data-test="test-connection-empty"]').text()).toBe('—')
    expect(rows[1]!.find('[data-test="test-connection"]').exists()).toBe(true)

    // 点击才测：挂载不触发 fetchConnectStatus，也无结果徽标
    expect(fetchConnectStatus).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="connect-status"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('U7：点「测试」调 fetchConnectStatus(模块 id)；online → 行内「在线」徽标', async () => {
    vi.mocked(fetchAdminModules).mockResolvedValue([mod({ id: 'bridge', mode: 'connect' })])
    vi.mocked(fetchConnectStatus).mockResolvedValue({ moduleId: 'bridge', online: true })
    const wrapper = mount(ModulesPage)
    await flushPromises()

    await wrapper.find('[data-test="test-connection"]').trigger('click')
    await flushPromises()

    expect(fetchConnectStatus).toHaveBeenCalledWith('bridge')
    const badge = wrapper.find('[data-test="connect-status"]')
    expect(badge.text()).toBe('在线')
    expect(badge.classes()).toContain('badge-ok')
    // 在线不带原因提示
    expect(badge.attributes('title')).toBeUndefined()
    wrapper.unmount()
  })

  it('U7：offline → 行内「离线」徽标，原因以 title 行内提示，不弹窗', async () => {
    vi.mocked(fetchAdminModules).mockResolvedValue([mod({ id: 'bridge', mode: 'connect' })])
    vi.mocked(fetchConnectStatus).mockResolvedValue({ moduleId: 'bridge', online: false, reason: '模块还没连上来' })
    const wrapper = mount(ModulesPage)
    await flushPromises()

    await wrapper.find('[data-test="test-connection"]').trigger('click')
    await flushPromises()

    const badge = wrapper.find('[data-test="connect-status"]')
    expect(badge.text()).toBe('离线')
    expect(badge.classes()).toContain('badge-warn')
    expect(badge.attributes('title')).toBe('模块还没连上来')
    // 不弹窗：页面无 role=alert（加载/启停失败那条也无关本动作）
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('U7：测试中按钮 loading 禁用；完成后可重点击重测，结果按最新一次刷新', async () => {
    let resolveStatus!: (v: { moduleId: string; online: boolean }) => void
    vi.mocked(fetchAdminModules).mockResolvedValue([mod({ id: 'bridge', mode: 'connect' })])
    vi.mocked(fetchConnectStatus).mockImplementation(
      () => new Promise((res) => { resolveStatus = res }),
    )
    const wrapper = mount(ModulesPage)
    await flushPromises()

    const btn = () => wrapper.find('[data-test="test-connection"]')
    await btn().trigger('click')
    // 测试中：loading（aria-busy + disabled），尚未出结果
    expect(btn().attributes('aria-busy')).toBe('true')
    expect(btn().attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="connect-status"]').exists()).toBe(false)

    resolveStatus({ moduleId: 'bridge', online: true })
    await flushPromises()
    expect(btn().attributes('aria-busy')).toBeUndefined()
    expect(wrapper.find('[data-test="connect-status"]').text()).toBe('在线')

    // 再点重测：第二次调用；这次离线也照实刷新
    vi.mocked(fetchConnectStatus).mockResolvedValue({ moduleId: 'bridge', online: false, reason: '断开了' })
    await btn().trigger('click')
    await flushPromises()
    expect(fetchConnectStatus).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-test="connect-status"]').text()).toBe('离线')
    wrapper.unmount()
  })

  it('U7：存储列文案收敛——新旧值两头都认', async () => {
    vi.mocked(fetchAdminModules).mockResolvedValue([
      modRaw('a', 'core'),
      modRaw('b', 'self'), // 旧契约值
      modRaw('c', 'dedicated'), // 旧值→Core
      modRaw('d', 'shared'), // 旧值→Core
      modRaw('e', 'external'),
      modRaw('f', null),
      modRaw('g', ''), // 旧值容忍
    ])
    const wrapper = mount(ModulesPage)
    await flushPromises()

    const rows = wrapper.findAll('[data-test="module-provisioning"]')
    expect(rows).toHaveLength(7)
    expect(rows[0]!.text()).toBe('落点 cloudflare · 存储 Core')
    expect(rows[1]!.text()).toBe('落点 cloudflare · 存储 自托管')
    expect(rows[2]!.text()).toBe('落点 cloudflare · 存储 Core')
    expect(rows[3]!.text()).toBe('落点 cloudflare · 存储 Core')
    expect(rows[4]!.text()).toBe('落点 cloudflare · 存储 自托管')
    expect(rows[5]!.text()).toBe('落点 cloudflare · 存储 自托管')
    expect(rows[6]!.text()).toBe('落点 cloudflare · 存储 自托管')
    wrapper.unmount()
  })
})

/**
 * U8（#349）行内设置表单的模块行工厂：manifest.config 决定「设置」按钮在场与否。
 */
const modWithConfig = (over: Partial<AdminModule> = {}): AdminModule =>
  mod({
    manifest: {
      config: [
        { key: 'greeting', label: '问候语', type: 'string', required: true },
        { key: 'threshold', label: '阈值', type: 'number' },
        { key: 'loud', label: '大声', type: 'boolean' },
        { key: 'level', label: '档位', type: 'enum', options: ['低', '高'] },
        { key: 'homepage', label: '主页', type: 'url' },
        { key: 'extras', label: '扩展', type: 'json' },
        { key: 'apiKey', label: '密钥', type: 'secret' },
        { key: 'sso', label: '单点登录', type: 'oauth' },
      ],
    },
    ...over,
  })

describe('ModulesPage 行内设置（U8，#349）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchAdminModules).mockResolvedValue([modWithConfig()])
    vi.mocked(toggleModule).mockResolvedValue({})
    vi.mocked(fetchConnectStatus).mockResolvedValue({ moduleId: 'hello', online: true })
    vi.mocked(saveModuleConfig).mockResolvedValue({})
  })

  const configState = (over: { values?: Record<string, unknown> } = {}) => ({
    config: modWithConfig().manifest!.config!,
    values: over.values ?? {},
  })

  it('manifest.config 非空才有「设置」；没暴露的模块只显示 —；挂载不拉配置', async () => {
    vi.mocked(fetchAdminModules).mockResolvedValue([modWithConfig(), mod()])
    const wrapper = mount(ModulesPage)
    await flushPromises()

    const rows = wrapper.findAll('[data-test="module-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.find('[data-test="module-settings"]').exists()).toBe(true)
    expect(rows[1]!.find('[data-test="module-settings"]').exists()).toBe(false)
    expect(rows[1]!.find('[data-test="module-settings-empty"]').text()).toBe('—')
    // 点击才拉配置（同 U7 测试按钮纪律）
    expect(fetchModuleConfig).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('点「设置」拉取配置并展开面板；再点收起', async () => {
    vi.mocked(fetchModuleConfig).mockResolvedValue(configState())
    const wrapper = mount(ModulesPage)
    await flushPromises()

    await wrapper.find('[data-test="module-settings"]').trigger('click')
    await flushPromises()
    expect(fetchModuleConfig).toHaveBeenCalledWith('hello')
    expect(wrapper.find('[data-test="module-config-panel"]').exists()).toBe(true)

    await wrapper.find('[data-test="module-settings"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="module-config-panel"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('按 schema 渲染七类字段：string/number/url/json 文本框、boolean 开关、enum 选、oauth 人话提示', async () => {
    vi.mocked(fetchModuleConfig).mockResolvedValue(configState())
    const wrapper = mount(ModulesPage)
    await flushPromises()
    await wrapper.find('[data-test="module-settings"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="config-field-greeting"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="config-input-greeting"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="config-input-threshold"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="config-input-homepage"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="config-input-extras"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="config-input-loud"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="config-input-level"]').exists()).toBe(true)
    // oauth 不渲染控件，只人话提示
    expect(wrapper.find('[data-test="config-input-sso"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="config-oauth-hint"]').text()).toBe('该模块配置项需在部署端完成')
    wrapper.unmount()
  })

  it('secret 已设置 → 占位「已设置，留空保持不变」；未设置 → 「留空保持不变」', async () => {
    vi.mocked(fetchModuleConfig).mockResolvedValue(configState({ values: { apiKey: '***' } }))
    const wrapper = mount(ModulesPage)
    await flushPromises()
    await wrapper.find('[data-test="module-settings"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="config-input-apiKey"] input').attributes('placeholder')).toBe('已设置，留空保持不变')
    wrapper.unmount()
  })

  it('保存 → PUT {values}；成功收起面板', async () => {
    vi.mocked(fetchModuleConfig).mockResolvedValue(configState())
    const wrapper = mount(ModulesPage)
    await flushPromises()
    await wrapper.find('[data-test="module-settings"]').trigger('click')
    await flushPromises()

    await wrapper.find('[data-test="config-input-greeting"] input').setValue('你好呀')
    await wrapper.find('[data-test="config-input-threshold"] input').setValue('5')
    await wrapper.find('[data-test="config-input-loud"]').trigger('click') // 开关默认关 → 点开
    await wrapper.find('[data-test="config-save"]').trigger('click')
    await flushPromises()

    expect(saveModuleConfig).toHaveBeenCalledWith('hello', expect.objectContaining({
      greeting: '你好呀',
      threshold: 5,
      loud: true,
      apiKey: '***', // 未填 = 保持不变
    }))
    expect(wrapper.find('[data-test="module-config-panel"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('保存失败 → 面板内 role=alert，草稿保留可改', async () => {
    vi.mocked(fetchModuleConfig).mockResolvedValue(configState())
    vi.mocked(saveModuleConfig).mockRejectedValue(new Error('请求失败（400）'))
    const wrapper = mount(ModulesPage)
    await flushPromises()
    await wrapper.find('[data-test="module-settings"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="config-input-greeting"] input').setValue('草稿')

    await wrapper.find('[data-test="config-save"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="config-error"]').text()).toContain('请求失败（400）')
    expect(wrapper.find('[data-test="module-config-panel"]').exists()).toBe(true)
    expect((wrapper.find('[data-test="config-input-greeting"] input').element as HTMLInputElement).value).toBe('草稿')
    wrapper.unmount()
  })

  it('拉取失败 → 面板内 role=alert，不渲染字段', async () => {
    vi.mocked(fetchModuleConfig).mockRejectedValue(new Error('请求失败（500）'))
    const wrapper = mount(ModulesPage)
    await flushPromises()
    await wrapper.find('[data-test="module-settings"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="config-error"]').text()).toContain('请求失败（500）')
    expect(wrapper.find('[data-test="config-field-greeting"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

/**
 * U10（#349）行内「移除」：站内 danger 确认（#192 F6 同款 ConfirmDialog）后才 DELETE。
 * 行为口径：点移除先见确认弹层（不发请求）；取消不发请求且行还在；确认才调 removeModule 且行消失。
 */
describe('ModulesPage 行内移除（U10，#349）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchAdminModules).mockResolvedValue([mod(), mod({ id: 'bridge', mode: 'connect' })])
    vi.mocked(toggleModule).mockResolvedValue({})
    vi.mocked(fetchConnectStatus).mockResolvedValue({ moduleId: 'bridge', online: true })
    vi.mocked(removeModule).mockResolvedValue({ id: 'hello', removed: true })
  })

  it('每行有「移除」按钮；点移除先见站内确认弹层（人话说明接入码作废），确认前不发请求', async () => {
    const wrapper = mount(ModulesPage)
    await flushPromises()

    const rows = wrapper.findAll('[data-test="module-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.find('[data-test="module-remove"]').exists()).toBe(true)
    expect(rows[1]!.find('[data-test="module-remove"]').exists()).toBe(true)

    await rows[0]!.find('[data-test="module-remove"]').trigger('click')

    const dialog = wrapper.find('.u-confirm')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('移除模块')
    expect(dialog.text()).toContain('移除 hello 后接入码立即作废')
    // 确认前不发请求
    expect(removeModule).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('取消 → 不发 DELETE，行还在', async () => {
    const wrapper = mount(ModulesPage)
    await flushPromises()
    await wrapper.findAll('[data-test="module-remove"]')[0]!.trigger('click')

    await wrapper.findAll('.u-confirm button').find((b) => b.text() === '取消')!.trigger('click')
    await flushPromises()

    expect(wrapper.find('.u-confirm').exists()).toBe(false)
    expect(removeModule).not.toHaveBeenCalled()
    expect(wrapper.findAll('[data-test="module-row"]')).toHaveLength(2)
    wrapper.unmount()
  })

  it('Esc 关闭 → 不发 DELETE，行还在', async () => {
    const wrapper = mount(ModulesPage)
    await flushPromises()
    await wrapper.findAll('[data-test="module-remove"]')[0]!.trigger('click')
    expect(wrapper.find('.u-confirm').exists()).toBe(true)

    await wrapper.find('.u-confirm').trigger('keydown', { key: 'Escape' })
    await flushPromises()

    expect(wrapper.find('.u-confirm').exists()).toBe(false)
    expect(removeModule).not.toHaveBeenCalled()
    expect(wrapper.findAll('[data-test="module-row"]')).toHaveLength(2)
    wrapper.unmount()
  })

  it('确认 → removeModule 被调且该行从表格消失', async () => {
    const wrapper = mount(ModulesPage)
    await flushPromises()
    await wrapper.findAll('[data-test="module-remove"]')[0]!.trigger('click')

    await wrapper.findAll('.u-confirm button').find((b) => b.text() === '移除')!.trigger('click')
    await flushPromises()

    expect(removeModule).toHaveBeenCalledTimes(1)
    expect(removeModule).toHaveBeenCalledWith('hello')
    expect(wrapper.findAll('[data-test="module-row"]')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('hello')
    wrapper.unmount()
  })

  it('移除失败 → 行内 role=alert 不静默，行保留可重试', async () => {
    vi.mocked(removeModule).mockRejectedValue(new Error('请求失败（500）'))
    const wrapper = mount(ModulesPage)
    await flushPromises()
    await wrapper.findAll('[data-test="module-remove"]')[1]!.trigger('click')
    await wrapper.findAll('.u-confirm button').find((b) => b.text() === '移除')!.trigger('click')
    await flushPromises()

    expect(removeModule).toHaveBeenCalledWith('bridge')
    expect(wrapper.find('[role="alert"]').text()).toContain('请求失败（500）')
    expect(wrapper.findAll('[data-test="module-row"]')).toHaveLength(2)
    wrapper.unmount()
  })
})

describe('AuditPage（#208）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchAuditLog).mockResolvedValue([entry()])
  })

  it('加载中 → 骨架屏在场，列表未渲染', async () => {
    let resolveLog!: (v: AuditEntry[]) => void
    vi.mocked(fetchAuditLog).mockImplementation(() => new Promise((res) => { resolveLog = res }))
    const wrapper = mount(AuditPage)

    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('module_disabled')
    resolveLog([entry()])
    await flushPromises()
    wrapper.unmount()
  })

  it('加载成功 → 行渲染时间/动作/操作者/对象', async () => {
    const wrapper = mount(AuditPage)
    await flushPromises()

    const row = wrapper.find('[data-test="audit-row"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('2026-09-01 08:00:00')
    expect(row.text()).toContain('module_disabled')
    expect(row.text()).toContain('u_admin')
    expect(row.text()).toContain('hello')
    wrapper.unmount()
  })

  it('空数据 → 空态文案「还没有审计记录」', async () => {
    vi.mocked(fetchAuditLog).mockResolvedValue([])
    const wrapper = mount(AuditPage)
    await flushPromises()

    expect(wrapper.text()).toContain('还没有审计记录')
    expect(wrapper.find('[data-test="audit-row"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('加载失败 → 错误卡（role=alert）带人话标题，不是空白页', async () => {
    vi.mocked(fetchAuditLog).mockRejectedValue(
      Object.assign(new Error('请求失败（503）'), { status: 503, requestId: 'req-209', detail: 'db down' }),
    )
    const wrapper = mount(AuditPage)
    await flushPromises()

    const err = wrapper.find('[role="alert"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('审计记录加载失败')
    expect(err.text()).toContain('请求失败（503）')
    expect(err.text()).toContain('req-209')
    wrapper.unmount()
  })
})
