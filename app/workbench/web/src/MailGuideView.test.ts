// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import MailGuideView from './MailGuideView.vue'
import { fetchMe } from './lib/session-api'

/**
 * 应用密码说明页（#168）行为测试：
 * 契约 = 用户可见结果——门户跳转指向服务端给的目标、没地址时不可点且有说明、
 * 未开邮件轴不给误导内容、未登录回登录页。不断类名/静态文案（docs/testing.md 禁项）。
 * （describe 名不带 #168——issue 号写在测试名里会被 verify-tokens 当裸颜色值误报，见 #169。）
 */

vi.mock('./lib/session-api', () => ({ fetchMe: vi.fn() }))

// 未登录整页跳登录：以 stub location 断言行为（jsdom 不可真实导航）。
const assignMock = vi.fn()
const ORIGIN = window.location.origin
Object.defineProperty(window, 'location', {
  value: { assign: assignMock, pathname: '/app-password', search: '', origin: ORIGIN },
  writable: true,
  configurable: true,
})

/** /api/me 200 结果（#168 起含邮件能力字段）。 */
function meOk(mailEnabled: boolean, mailPortalUrl: string | null) {
  return {
    authenticated: true as const,
    user: { id: 'u1', name: '黄一', issuer: 'unself', sub: 'u1', role: 'user' },
    mailEnabled,
    mailPortalUrl,
  }
}

let router: Router

async function mountView() {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/app-password', component: MailGuideView },
    ],
  })
  await router.push('/app-password')
  await router.isReady()
  const wrapper = mount(MailGuideView, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  assignMock.mockClear()
})

describe('应用密码说明页', () => {
  it('门户地址就位：给出真跳转锚点（href = 服务端解析值，新窗口打开）', async () => {
    vi.mocked(fetchMe).mockResolvedValue(meOk(true, 'https://mail.example.com/portal'))

    const wrapper = await mountView()

    const portal = wrapper.find('a[href="https://mail.example.com/portal"]')
    expect(portal.exists()).toBe(true)
    expect(portal.isVisible()).toBe(true)
    expect(portal.attributes('target')).toBe('_blank')
    // 页面含可执行的生成步骤（需求「步骤说明」）：至少一个有序步骤列表且步骤数 ≥ 3。
    const steps = wrapper.findAll('ol li')
    expect(steps.length).toBeGreaterThanOrEqual(3)
    wrapper.unmount()
  })

  it('门户地址缺失（portalUrl/domain 都无）：没有可点跳转，按钮禁用并说明向管理员索取', async () => {
    vi.mocked(fetchMe).mockResolvedValue(meOk(true, null))

    const wrapper = await mountView()

    expect(wrapper.find('a[href^="http"]').exists()).toBe(false)
    const disabled = wrapper.find('[data-test="portal-disabled"]')
    expect(disabled.exists()).toBe(true)
    expect((disabled.element as HTMLButtonElement).disabled).toBe(true)
    // 状态相关提示（允许断言）：告诉用户下一步找谁。
    expect(wrapper.text()).toContain('请向管理员索取门户地址')
    wrapper.unmount()
  })

  it('邮件轴关：直接访问路由只给中性提示，不展示步骤也不给门户动作（不误导）', async () => {
    vi.mocked(fetchMe).mockResolvedValue(meOk(false, null))

    const wrapper = await mountView()

    expect(wrapper.text()).toContain('未开启邮件服务')
    expect(wrapper.find('a[href^="http"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="portal-disabled"]').exists()).toBe(false)
    expect(wrapper.findAll('ol')).toHaveLength(0)
    wrapper.unmount()
  })

  it('未登录访问：整页回登录页并带 next 回跳（登录后回到本页）', async () => {
    vi.mocked(fetchMe).mockResolvedValue({ authenticated: false })

    const wrapper = await mountView()

    expect(assignMock).toHaveBeenCalledWith('/login?next=%2Fapp-password')
    wrapper.unmount()
  })
})
