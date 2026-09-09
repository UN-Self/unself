// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import App from './App.vue'
import { fetchMe, logout } from './lib/session-api'
import { fetchEnabledModules } from './lib/registry-api'
import { fetchModuleToken } from './lib/token-api'

const { TOKEN, MODULE, REJECTED } = vi.hoisted(() => {
  const TOKEN = {
    token: 'tok-1',
    expiresIn: 600,
    claims: {
      iss: 'unself',
      sub: 'u1',
      aud: 'hello',
      iat: 1_700_000_000,
      exp: 1_700_000_600,
    },
  }
  /** enabled 模块：manifest.entry 同域路径（§5.3 单域名路径制）。 */
  const MODULE = {
    id: 'hello',
    enabled: true,
    version: '0.1.0',
    manifest: {
      id: 'hello',
      route: '/m/hello/',
      entry: '/m/hello/',
      runtime: 'vue',
      version: '0.1.0',
    },
  }
  const REJECTED = Object.assign(new Error('登录已过期，请重新登录'), { status: 401 })
  return { TOKEN, MODULE, REJECTED }
})

// 登出动作的可见结果是整页跳 /login：以 stub location 断言行为（jsdom 不可真实导航）。
const ORIGIN = window.location.origin
const assignMock = vi.fn()
Object.defineProperty(window, 'location', {
  value: { assign: assignMock, pathname: '/', search: '', origin: ORIGIN },
  writable: true,
  configurable: true,
})

vi.mock('./lib/session-api', () => ({
  fetchMe: vi.fn().mockResolvedValue({
    authenticated: true,
    user: { id: 'u1', name: '黄一', issuer: 'unself', sub: 'u1' },
  }),
  loginUrl: (next?: string) => `/api/auth/login${next ? `?next=${encodeURIComponent(next)}` : ''}`,
  logout: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./lib/registry-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/registry-api')>()
  return {
    ...actual,
    fetchEnabledModules: vi.fn().mockResolvedValue([MODULE]),
  }
})

vi.mock('./lib/token-api', () => ({
  fetchModuleToken: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  assignMock.mockClear()
})

/** 冲刷挂载 → 拉注册表 → 选模块 → post-flush 挂桥整条异步链。 */
async function settle() {
  await flushPromises()
  await nextTick()
  await flushPromises()
  await nextTick()
  await flushPromises()
}

/** 模拟 iframe 内 SDK 发 ready（真实 MessageEvent，走真实桥的消息监听）。 */
function dispatchReady(iframe: HTMLIFrameElement) {
  const ev = new MessageEvent('message', {
    data: { type: 'ready' },
    origin: window.location.origin,
    source: iframe.contentWindow,
  })
  window.dispatchEvent(ev)
}

// 注意：jsdom 中未挂入 document 的 iframe 共享同一 contentWindow，
// 因此每个用例必须 wrapper.unmount()（触发 onBeforeUnmount 拆桥），
// 否则上一个用例的桥监听器会截获下一个用例的 ready 事件。
describe('App.vue 模块桥挂载时机（#71 根因 2）', () => {
  it('桥在 iframe 挂载后 attach：ready → token → frameState ready（不误判配置无效）', async () => {
    vi.mocked(fetchModuleToken).mockResolvedValue(TOKEN)
    vi.mocked(fetchMe).mockResolvedValue({
      authenticated: true,
      user: { id: 'u1', name: '黄一', issuer: 'unself', sub: 'u1' },
    })
    vi.mocked(fetchEnabledModules).mockResolvedValue([MODULE])

    const wrapper = mount(App)
    await settle()

    const iframeEl = wrapper.find('iframe')
    expect(iframeEl.exists()).toBe(true)
    // 落地规则：直访 / 落第一个启用模块 → hello 进入握手期（骨架可见、帧隐藏）
    expect(iframeEl.attributes('src')).toBe('/m/hello/')
    expect(iframeEl.classes()).toContain('mh-frame-hidden')
    expect(wrapper.text()).not.toContain('模块入口配置无效')

    dispatchReady(iframeEl.element as HTMLIFrameElement)
    await settle()

    // 行为断言：真实桥收到了 ready → 以 'hello' 请求 token → 下发 → 帧就位
    expect(fetchModuleToken).toHaveBeenCalledTimes(1)
    expect(fetchModuleToken).toHaveBeenCalledWith('hello')
    expect(wrapper.find('iframe').classes()).not.toContain('mh-frame-hidden')
    expect(wrapper.text()).not.toContain('模块加载失败')
    expect(wrapper.text()).not.toContain('模块入口配置无效')

    wrapper.unmount()
  })

  it('retry 强制 iframe 重挂（key 变化 → DOM 替换）后对新帧重新挂桥', async () => {
    vi.mocked(fetchModuleToken)
      .mockRejectedValueOnce(REJECTED)
      .mockResolvedValue(TOKEN)
    vi.mocked(fetchMe).mockResolvedValue({
      authenticated: true,
      user: { id: 'u1', name: '黄一', issuer: 'unself', sub: 'u1' },
    })
    vi.mocked(fetchEnabledModules).mockResolvedValue([MODULE])

    const wrapper = mount(App)
    await settle()

    const before = wrapper.find('iframe').element as HTMLIFrameElement
    expect(before).toBeTruthy()

    // 首次 ready → 领 token 失败（401）→ 失败卡
    dispatchReady(before)
    await settle()
    expect(fetchModuleToken).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('模块加载失败')
    const retry = wrapper.find('button.u-error-retry')
    expect(retry.text()).toBe('重新加载')

    // retry：frameReload 自增 → iframe 按 key 重挂（DOM 元素被替换）
    await retry.trigger('click')
    await settle()

    const after = wrapper.find('iframe').element as HTMLIFrameElement
    expect(after).not.toBe(before)
    expect(after.getAttribute('src')).toBe('/m/hello/')

    // 新 iframe 重新发 ready → 真实桥对新帧再次取 token → 就位
    dispatchReady(after)
    await settle()
    expect(fetchModuleToken).toHaveBeenCalledTimes(2)
    expect(fetchModuleToken).toHaveBeenNthCalledWith(2, 'hello')
    expect(wrapper.find('iframe').classes()).not.toContain('mh-frame-hidden')
    expect(wrapper.text()).not.toContain('模块加载失败')

    wrapper.unmount()
  })

  it('token 接口 403 时异常卡以「此模块已停用」示人（#83 状态判定，非字符串嗅探）', async () => {
    const DISABLED = Object.assign(new Error('此模块已停用'), { status: 403 })
    vi.mocked(fetchModuleToken).mockRejectedValue(DISABLED)
    vi.mocked(fetchMe).mockResolvedValue({
      authenticated: true,
      user: { id: 'u1', name: '黄一', issuer: 'unself', sub: 'u1' },
    })
    vi.mocked(fetchEnabledModules).mockResolvedValue([MODULE])

    const wrapper = mount(App)
    await settle()

    dispatchReady(wrapper.find('iframe').element as HTMLIFrameElement)
    await settle()

    expect(wrapper.text()).toContain('此模块已停用')
    expect(wrapper.text()).not.toContain('模块加载失败')

    wrapper.unmount()
  })
})

/**
 * 退出登录（#83 摘录 #75：getComputedStyle 类布局断言不迁移不扩散，
 * 本文件被触碰后改为行为断言——契约是「无论用户名多长，退出都可点且触发登出流程」）。
 */
describe('App.vue 退出登录行为', () => {
  const LONG_NAME = 'handy@unself.demo.example'
  const SHORT_NAME = '黄一'

  async function mountAs(name: string) {
    vi.mocked(fetchMe).mockResolvedValue({
      authenticated: true,
      user: { id: 'u1', name, issuer: 'unself', sub: 'u1' },
    })
    vi.mocked(fetchEnabledModules).mockResolvedValue([])
    const wrapper = mount(App)
    await settle()
    return wrapper
  }

  it('长用户名：桌面侧栏「退出」可点，点击触发 logout 并跳 /login', async () => {
    const wrapper = await mountAs(LONG_NAME)
    expect(wrapper.find('.shell-user-name').text()).toBe(LONG_NAME)

    const btn = wrapper.find('.shell-logout')
    expect(btn.text()).toBe('退出')
    await btn.trigger('click')
    await flushPromises()

    expect(logout).toHaveBeenCalledTimes(1)
    expect(assignMock).toHaveBeenCalledWith('/login')
    wrapper.unmount()
  })

  it('短用户名回归：同一登出契约不被破坏', async () => {
    const wrapper = await mountAs(SHORT_NAME)
    expect(wrapper.find('.shell-user-name').text()).toBe(SHORT_NAME)

    const btn = wrapper.find('.shell-logout')
    await btn.trigger('click')
    await flushPromises()

    expect(logout).toHaveBeenCalledTimes(1)
    expect(assignMock).toHaveBeenCalledWith('/login')
    wrapper.unmount()
  })

  it('移动端：底部标签栏「我的」→ 动作单显示用户名与退出，退出即登出跳 /login', async () => {
    const wrapper = await mountAs(SHORT_NAME)

    const meTab = wrapper.findAll('.shell-tab').find((b) => b.text() === '我的')
    expect(meTab).toBeTruthy()
    await meTab!.trigger('click')

    // 动作单展示用户名 + 退出按钮（可点击性 = 行为契约）
    const sheet = wrapper.find('.shell-sheet')
    expect(sheet.exists()).toBe(true)
    expect(sheet.text()).toContain(SHORT_NAME)
    expect(sheet.text()).toContain('退出登录')

    await wrapper.find('.shell-sheet-logout').trigger('click')
    await flushPromises()
    expect(logout).toHaveBeenCalledTimes(1)
    expect(assignMock).toHaveBeenCalledWith('/login')
    wrapper.unmount()
  })

  it('移动端动作单：点遮罩关闭（不触发登出）', async () => {
    const wrapper = await mountAs(SHORT_NAME)

    const meTab = wrapper.findAll('.shell-tab').find((b) => b.text() === '我的')
    await meTab!.trigger('click')
    expect(wrapper.find('.shell-sheet').exists()).toBe(true)

    await wrapper.find('.shell-sheet-backdrop').trigger('click')
    expect(wrapper.find('.shell-sheet').exists()).toBe(false)
    expect(logout).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
