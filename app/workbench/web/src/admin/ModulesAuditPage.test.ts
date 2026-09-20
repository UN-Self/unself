// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import AuditPage from './AuditPage.vue'
import ModulesPage from './ModulesPage.vue'
import { fetchAdminModules, fetchAuditLog, toggleModule, type AdminModule, type AuditEntry } from '../lib/admin-api'

/**
 * ModulesPage / AuditPage 行为测试（#208，docs/testing.md 两问检验）：
 * - 模块页：加载三态（骨架/错误卡/列表）+ 空态 + 启停开关行内翻转与失败提示
 * - 审计页：加载三态 + 空态 + 倒序只读行（时间/动作/操作者/对象）
 * 均通过 mock 数据源函数（fetchAdminModules/fetchAuditLog/toggleModule）驱动状态，
 * 断言用户可见结果（骨架在场、行文本、role=alert），不碰实现细节。
 */

vi.mock('../lib/admin-api', () => ({
  fetchAdminModules: vi.fn(),
  toggleModule: vi.fn(),
  fetchAuditLog: vi.fn(),
}))

const mod = (over: Partial<AdminModule> = {}): AdminModule => ({ id: 'hello', enabled: true, version: '0.1.0', ...over })

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
