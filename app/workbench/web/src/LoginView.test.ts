// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import LoginView from './LoginView.vue'
import { getAuthMethods, loginWithPassword } from './lib/builtin-auth-api'
import { fetchMe } from './lib/session-api'

/**
 * 登录页行为（issue-A）：密码表单默认、SSO 按钮按 methods.oidc 显隐、
 * 提交发登录请求并回 next；错误人话可见。测用户可见行为，不测结构。
 */

const routerReplace = vi.fn()
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => ({ query: {} as Record<string, string> }),
    useRouter: () => ({ replace: routerReplace }),
  }
})

vi.mock('./lib/builtin-auth-api', () => ({
  getAuthMethods: vi.fn(),
  loginWithPassword: vi.fn(),
}))

vi.mock('./lib/session-api', () => ({
  fetchMe: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchMe).mockResolvedValue({ authenticated: false })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function mountLogin() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div data-test="workspace" />' } },
      { path: '/login', component: LoginView },
    ],
  })
  router.push('/login')
  await router.isReady()
  const wrapper = mount(LoginView, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}
describe('LoginView（issue-A）', () => {
  it('默认渲染用户名+密码表单与登录按钮；未配 SSO 时无 SSO 按钮', async () => {
    vi.mocked(getAuthMethods).mockResolvedValue({ builtin: true, oidc: false })
    const { wrapper } = await mountLogin()

    expect(wrapper.find('input[name="username"]').exists()).toBe(true)
    expect(wrapper.find('input[name="password"]').exists()).toBe(true)
    const buttons = wrapper.findAll('button')
    expect(buttons.some((b) => b.text().includes('登录'))).toBe(true)
    expect(buttons.some((b) => b.text().includes('SSO 登录'))).toBe(false)
  })

  it('methods.oidc=true → SSO 按钮出现，点击整页跳转 /api/auth/login', async () => {
    vi.mocked(getAuthMethods).mockResolvedValue({ builtin: true, oidc: true })
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    const { wrapper } = await mountLogin()

    const sso = wrapper.findAll('button').find((b) => b.text().includes('SSO 登录'))
    expect(sso).toBeDefined()
    await sso!.trigger('click')
    expect(assign).toHaveBeenCalledWith('/api/auth/login')
  })

  it('methods 探测失败：静默降级，无 SSO 按钮，密码表单仍可用', async () => {
    vi.mocked(getAuthMethods).mockRejectedValue(new Error('网络不可用，请检查连接后重试'))
    const { wrapper } = await mountLogin()

    expect(wrapper.findAll('button').some((b) => b.text().includes('SSO 登录'))).toBe(false)
    expect(wrapper.find('input[name="username"]').exists()).toBe(true)
  })

  it('提交：loginWithPassword 收到用户名密码 → 跳转工作台（useRouter.replace 被调）', async () => {
    vi.mocked(getAuthMethods).mockResolvedValue({ builtin: true, oidc: false })
    vi.mocked(loginWithPassword).mockResolvedValue(undefined)
    const { wrapper } = await mountLogin()

    await wrapper.find('input[name="username"]').setValue('alice')
    await wrapper.find('input[name="password"]').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(loginWithPassword).toHaveBeenCalledWith('alice', 'password123')
    expect(routerReplace).toHaveBeenCalledWith('/')
  })

  it('登录失败：后端人话可见，不跳转', async () => {
    vi.mocked(getAuthMethods).mockResolvedValue({ builtin: true, oidc: false })
    vi.mocked(loginWithPassword).mockRejectedValue(
      Object.assign(new Error('用户名或密码错误'), { status: 401 }),
    )
    const { wrapper, router } = await mountLogin()

    await wrapper.find('input[name="username"]').setValue('alice')
    await wrapper.find('input[name="password"]').setValue('wrong-password')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toContain('用户名或密码错误')
    expect(router.currentRoute.value.path).toBe('/login')
  })
})
