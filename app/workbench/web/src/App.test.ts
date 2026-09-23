// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import App from './App.vue'
import { fetchMe, logout } from './lib/session-api'
import { fetchEnabledModules } from './lib/registry-api'
import { fetchModuleToken } from './lib/token-api'
import { HANDSHAKE_TIMEOUT_MS } from './lib/use-module-frame'

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
      runtimes: ['worker'],
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
    mailEnabled: false,
    mailPortalUrl: null,
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

/** /api/me 200 结果（#168 起含邮件能力字段；缺省未开轴、无门户地址）。 */
function meOk(
  user: { id: string; name: string; role?: string },
  extras: { mailEnabled?: boolean; mailPortalUrl?: string | null } = {},
) {
  return {
    authenticated: true as const,
    user: { issuer: 'unself', sub: user.id, ...user },
    mailEnabled: extras.mailEnabled ?? false,
    mailPortalUrl: extras.mailPortalUrl ?? null,
  }
}

/** 冲刷挂载 → 拉注册表 → 选模块 → post-flush 挂桥整条异步链。 */
async function settle() {
  await flushPromises()
  await nextTick()
  await flushPromises()
  await nextTick()
  await flushPromises()
}

/**
 * 工作台在真实运行中挂在路由 '/' 下（main.ts 根组件 = RouterView）；
 * 测试同构：装真实路由（memory history）→ 点击入口即真实路由变化（#166）。
 */
let router: Router

async function mountApp(attach = false) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: App },
      { path: '/admin/:page?', component: { template: '<div />' } },
      { path: '/app-password', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()
  // attach=true：真实 DOM 挂载（焦点行为断言需要 document.activeElement 生效）
  return mount(App, {
    global: { plugins: [router] },
    ...(attach ? { attachTo: document.body } : {}),
  })
}

function currentPath(): string {
  return router.currentRoute.value.path
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
    vi.mocked(fetchMe).mockResolvedValue(meOk({ id: 'u1', name: '黄一' }))
    vi.mocked(fetchEnabledModules).mockResolvedValue([MODULE])

    const wrapper = await mountApp()
    await settle()

    const iframeEl = wrapper.find('iframe')
    expect(iframeEl.exists()).toBe(true)
    // 落地规则：直访 / 落第一个启用模块 → hello 进入握手期（骨架可见）
    expect(iframeEl.attributes('src')).toBe('/m/hello/')
    // 用户可见行为：握手期用户看到的是「正在连接模块…」加载骨架（aria-busy），
    // 这是用户可感知的「加载中」姿态——而非加不加 mh-frame-hidden 类（渲染细节，用户看不到）
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    expect(wrapper.find('[aria-busy="true"]').text()).toContain('正在连接模块…')
    expect(wrapper.text()).not.toContain('模块入口配置无效')

    dispatchReady(iframeEl.element as HTMLIFrameElement)
    await settle()

    // 行为断言：真实桥收到了 ready → 以 'hello' 请求 token → 下发 → 帧就位
    expect(fetchModuleToken).toHaveBeenCalledTimes(1)
    expect(fetchModuleToken).toHaveBeenCalledWith('hello')
    // 用户可见行为：ready 后加载骨架退场——用户看到的是模块内容而非「加载中」，
    // 而非断言 mh-frame-hidden 类（隐藏 iframe 的渲染细节，不代表用户感知状态）
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('模块加载失败')
    expect(wrapper.text()).not.toContain('模块入口配置无效')

    wrapper.unmount()
  })

  it('retry 强制 iframe 重挂（key 变化 → DOM 替换）后对新帧重新挂桥', async () => {
    vi.mocked(fetchModuleToken)
      .mockRejectedValueOnce(REJECTED)
      .mockResolvedValue(TOKEN)
    vi.mocked(fetchMe).mockResolvedValue(meOk({ id: 'u1', name: '黄一' }))
    vi.mocked(fetchEnabledModules).mockResolvedValue([MODULE])

    const wrapper = await mountApp()
    await settle()

    const before = wrapper.find('iframe').element as HTMLIFrameElement
    expect(before).toBeTruthy()

    // 首次 ready → 领 token 失败（401）→ 失败卡
    dispatchReady(before)
    await settle()
    expect(fetchModuleToken).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('模块加载失败')
    // 重试入口 = 异常卡上的重试按钮（用户可见文案定位，非样式类名）
    const retry = wrapper.find('[data-test="module-error-card"] button')
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
    // 用户可见行为：重挂后就位，加载骨架退场（用户看到模块内容而非加载中）——
    // 与 ready 状态是用户可感知对应，mh-frame-hidden 类只是实现细节
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('模块加载失败')

    wrapper.unmount()
  })

  it('token 接口 403 时异常卡以「此模块已停用」示人（#83 状态判定，非字符串嗅探）', async () => {
    const DISABLED = Object.assign(new Error('此模块已停用'), { status: 403 })
    vi.mocked(fetchModuleToken).mockRejectedValue(DISABLED)
    vi.mocked(fetchMe).mockResolvedValue(meOk({ id: 'u1', name: '黄一' }))
    vi.mocked(fetchEnabledModules).mockResolvedValue([MODULE])

    const wrapper = await mountApp()
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

  async function mountAs(name: string, attach = false) {
    vi.mocked(fetchMe).mockResolvedValue(meOk({ id: 'u1', name }))
    vi.mocked(fetchEnabledModules).mockResolvedValue([])
    const wrapper = await mountApp(attach)
    await settle()
    return wrapper
  }

  it('长用户名：桌面侧栏「退出」可点，点击触发 logout 并跳 /login', async () => {
    const wrapper = await mountAs(LONG_NAME)
    expect(wrapper.find('[data-test="user-name"]').text()).toBe(LONG_NAME)

    const btn = wrapper.find('[data-test="logout"]')
    expect(btn.text()).toBe('退出')
    await btn.trigger('click')
    await flushPromises()

    expect(logout).toHaveBeenCalledTimes(1)
    expect(assignMock).toHaveBeenCalledWith('/login')
    wrapper.unmount()
  })

  it('短用户名回归：同一登出契约不被破坏', async () => {
    const wrapper = await mountAs(SHORT_NAME)
    expect(wrapper.find('[data-test="user-name"]').text()).toBe(SHORT_NAME)

    const btn = wrapper.find('[data-test="logout"]')
    await btn.trigger('click')
    await flushPromises()

    expect(logout).toHaveBeenCalledTimes(1)
    expect(assignMock).toHaveBeenCalledWith('/login')
    wrapper.unmount()
  })

  it('移动端：底部标签栏「我的」→ 动作单显示用户名与退出，退出即登出跳 /login', async () => {
    const wrapper = await mountAs(SHORT_NAME)

    const meTab = wrapper.findAll('[data-test="me-tab"]').find((b) => b.text() === '我的')
    expect(meTab).toBeTruthy()
    await meTab!.trigger('click')

    // 动作单展示用户名 + 退出按钮（可点击性 = 行为契约）
    const sheet = wrapper.find('[data-test="me-sheet"]')
    expect(sheet.exists()).toBe(true)
    expect(sheet.text()).toContain(SHORT_NAME)
    expect(sheet.text()).toContain('退出登录')

    await wrapper.find('[data-test="sheet-logout"]').trigger('click')
    await flushPromises()
    expect(logout).toHaveBeenCalledTimes(1)
    expect(assignMock).toHaveBeenCalledWith('/login')
    wrapper.unmount()
  })

  it('移动端动作单：点遮罩关闭（不触发登出）', async () => {
    const wrapper = await mountAs(SHORT_NAME)

    const meTab = wrapper.findAll('[data-test="me-tab"]').find((b) => b.text() === '我的')
    await meTab!.trigger('click')
    expect(wrapper.find('[data-test="me-sheet"]').exists()).toBe(true)

    await wrapper.find('[data-test="me-sheet-backdrop"]').trigger('click')
    expect(wrapper.find('[data-test="me-sheet"]').exists()).toBe(false)
    expect(logout).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('移动端动作单：打开焦点入内 + Esc 关闭 + 焦点回「我的」标签（#192 F5）', async () => {
    const wrapper = await mountAs(SHORT_NAME, true)

    const meTab = wrapper.findAll('.shell-tab').find((b) => b.text() === '我的')!
    // jsdom 点按钮不自动聚焦，手工模拟触发元素已聚焦（与真实浏览器一致）
    ;(meTab.element as HTMLElement).focus()
    await meTab.trigger('click')
    await flushPromises()

    const sheet = wrapper.find('.shell-sheet')
    expect(sheet.exists()).toBe(true)
    // 打开时焦点入内（弹层内可聚焦元素）
    expect(sheet.element.contains(document.activeElement)).toBe(true)

    await sheet.trigger('keydown', { key: 'Escape' })
    await flushPromises()

    expect(wrapper.find('.shell-sheet').exists()).toBe(false)
    // 关闭后焦点回触发元素
    expect(document.activeElement).toBe(meTab.element)
    expect(logout).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

/**
 * 管理台入口（#166）：role 取自 /api/me，非 admin 完全不渲染。
 * 契约 = 用户可见结果：入口在/不在 + 点击后的真实路由变化
 * （以导航目标定位入口，不断言类名/静态文案，见 docs/testing.md 禁项）。
 */
describe('App.vue 管理台入口（#166）', () => {
  /** 管理台入口 = 指向 /admin/members 的可导航元素。 */
  const ADMIN_ENTRY = 'a[href="/admin/members"]'

  async function mountAsRole(role?: string) {
    vi.mocked(fetchMe).mockResolvedValue(meOk({ id: 'u1', name: '黄一', role }))
    vi.mocked(fetchEnabledModules).mockResolvedValue([])
    const wrapper = await mountApp()
    await settle()
    return wrapper
  }

  /** 手机端「我的」动作单：底部标签栏既定入口（#83），返回对话框容器。 */
  async function openMeSheet(wrapper: ReturnType<typeof mount>) {
    const meTab = wrapper.findAll('[data-test="me-tab"]').find((b) => b.text() === '我的')
    expect(meTab).toBeTruthy()
    await meTab!.trigger('click')
    return wrapper.find('[role="dialog"]')
  }

  it('管理员：桌面侧栏入口可见，点击即进 /admin/members', async () => {
    const wrapper = await mountAsRole('admin')

    const desktop = wrapper.find(`aside ${ADMIN_ENTRY}`)
    expect(desktop.exists()).toBe(true)
    expect(desktop.isVisible()).toBe(true)

    await desktop.trigger('click')
    await flushPromises()
    expect(currentPath()).toBe('/admin/members')
    wrapper.unmount()
  })

  it('管理员：手机「我的」动作单入口可见，点击进 /admin/members 并收起动作单', async () => {
    const wrapper = await mountAsRole('admin')

    const sheet = await openMeSheet(wrapper)
    expect(sheet.exists()).toBe(true)
    const mobile = sheet.find(ADMIN_ENTRY)
    expect(mobile.exists()).toBe(true)
    expect(mobile.isVisible()).toBe(true)

    await mobile.trigger('click')
    await flushPromises()
    expect(currentPath()).toBe('/admin/members')
    expect(wrapper.find('[data-test="me-sheet"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('普通成员：桌面与手机动作单都没有通往管理台的可导航元素', async () => {
    const wrapper = await mountAsRole('user')

    expect(wrapper.findAll(ADMIN_ENTRY)).toHaveLength(0)
    await openMeSheet(wrapper)
    expect(wrapper.findAll(ADMIN_ENTRY)).toHaveLength(0)
    expect(wrapper.findAll('a[href^="/admin"]')).toHaveLength(0)
    expect(currentPath()).toBe('/')
    wrapper.unmount()
  })

  it('role 缺失（服务端未返回）：同样不显示入口（只认 admin）', async () => {
    const wrapper = await mountAsRole(undefined)

    expect(wrapper.findAll(ADMIN_ENTRY)).toHaveLength(0)
    wrapper.unmount()
  })
})

/**
 * 应用密码入口（#168）：mailEnabled 取自 /api/me，未开轴完全不渲染。
 * 这是成员功能（非 admin 也要看得到），位置与管理台同族（桌面用户区 + 手机「我的」）；
 * 契约 = 用户可见结果：入口在/不在 + 点击后的真实路由变化。
 * （describe 名不带 #168——issue 号写在测试名里会被 verify-tokens 当裸颜色值误报，见 #169。）
 */
describe('整页路由切换过渡（#307 ③导航层）', () => {
  /** 与下方管理台入口 describe 同款装配（函数作用域限本 describe，不跨共享）。 */
  async function mountAdminRole(): Promise<ReturnType<typeof mount>> {
    vi.mocked(fetchMe).mockResolvedValue(meOk({ id: 'u1', name: '黄一', role: 'admin' }))
    vi.mocked(fetchEnabledModules).mockResolvedValue([])
    const wrapper = await mountApp()
    await settle()
    return wrapper
  }

  it('路由切换：点管理台入口 → 整页换视图（out-in 过渡挂载点工作，新视图呈现）', async () => {
    const wrapper = await mountAdminRole()
    await wrapper.find('aside [data-test="admin-entry"]').trigger('click')
    await flushPromises()
    // 行为断言：导航真的发生了（过渡承载切换，不改变导航语义本身）
    expect(currentPath()).toBe('/admin/members')
    wrapper.unmount()
  })
})

describe('App.vue 应用密码入口（成员可见）', () => {
  /** 说明页入口 = 指向 /app-password 的可导航元素。 */
  const MAIL_ENTRY = 'a[href="/app-password"]'

  async function mountAsMail(mailEnabled: boolean) {
    vi.mocked(fetchMe).mockResolvedValue(
      meOk(
        { id: 'u1', name: '黄一', role: 'user' },
        { mailEnabled, mailPortalUrl: mailEnabled ? 'https://mail.example.com' : null },
      ),
    )
    vi.mocked(fetchEnabledModules).mockResolvedValue([])
    const wrapper = await mountApp()
    await settle()
    return wrapper
  }

  it('邮件轴开：普通成员在桌面侧栏看到入口，点击即进 /app-password 说明页', async () => {
    const wrapper = await mountAsMail(true)

    const desktop = wrapper.find(`aside ${MAIL_ENTRY}`)
    expect(desktop.exists()).toBe(true)
    expect(desktop.isVisible()).toBe(true)

    await desktop.trigger('click')
    await flushPromises()
    expect(currentPath()).toBe('/app-password')
    wrapper.unmount()
  })

  it('邮件轴开：手机「我的」动作单同样有入口，点击进说明页并收起动作单', async () => {
    const wrapper = await mountAsMail(true)

    const meTab = wrapper.findAll('[data-test="me-tab"]').find((b) => b.text() === '我的')
    await meTab!.trigger('click')
    const sheet = wrapper.find('[role="dialog"]')
    expect(sheet.exists()).toBe(true)

    const mobile = sheet.find(MAIL_ENTRY)
    expect(mobile.exists()).toBe(true)
    expect(mobile.isVisible()).toBe(true)

    await mobile.trigger('click')
    await flushPromises()
    expect(currentPath()).toBe('/app-password')
    expect(wrapper.find('[data-test="me-sheet"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('邮件轴关：桌面与手机动作单都没有通往说明页的可导航元素', async () => {
    const wrapper = await mountAsMail(false)

    expect(wrapper.findAll(MAIL_ENTRY)).toHaveLength(0)

    const meTab = wrapper.findAll('[data-test="me-tab"]').find((b) => b.text() === '我的')
    await meTab!.trigger('click')
    expect(wrapper.findAll(MAIL_ENTRY)).toHaveLength(0)
    expect(currentPath()).toBe('/')
    wrapper.unmount()
  })
})

/**
 * #306「停用 → 启用 → 点模块」回归：
 * probe304 现场 = 停用 hello 再启用后回工作台点 hello，iframe 永久停在「正在连接模块…」，
 * 15s 也不转失败卡。本组用例锁两条用户可见行为：
 * ① 模块没发 ready（或握手消息丢失）时，15s 必须落到失败卡（人话 + 请求编号），不是永久骨架；
 * ② 用户对「已选中的同一个模块」再点一次 = 明确的再试意图，必须真的重挂一次握手，
 *    且重挂后模块发来 ready 就能正常就位（显示身份/可交互），不能被上一轮状态粘住。
 * 断言只取用户可见结果（骨架/失败卡/请求编号/重挂后是否就位），不判 DOM 结构与类名。
 */
describe('App.vue 停用→启用→点模块回归（#306）', () => {
  /** 握手期的用户可见姿态：加载骨架 + 「正在连接模块…」。 */
  function handshaking(wrapper: ReturnType<typeof mount>): boolean {
    return wrapper.find('[aria-busy="true"]').exists()
  }

  /** 失败卡的用户可见姿态：人话标题 + 请求编号。 */
  function failureCard(wrapper: ReturnType<typeof mount>) {
    return wrapper.find('[data-test="module-error-card"]')
  }

  /** 桌面左栏里指向某模块的导航按钮（按可见标签文案定位，不判类名）。 */
  function navButton(wrapper: ReturnType<typeof mount>, label: string) {
    return wrapper
      .find('nav[aria-label="模块导航"]')
      .findAll('button')
      .find((b) => b.text().endsWith(label))
  }

  it('ready 一直不来：15s 后从骨架转失败卡（人话 + 请求编号），骨架不再永久滞留', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchModuleToken).mockResolvedValue(TOKEN)
      vi.mocked(fetchMe).mockResolvedValue(meOk({ id: 'u1', name: '黄一' }))
      vi.mocked(fetchEnabledModules).mockResolvedValue([MODULE])

      const wrapper = await mountApp()
      await settle()

      // 落地即选中 hello：用户看到的是「正在连接模块…」骨架
      expect(wrapper.find('iframe').attributes('src')).toBe('/m/hello/')
      expect(handshaking(wrapper)).toBe(true)
      expect(failureCard(wrapper).exists()).toBe(false)

      // 模块始终不发 ready（probe304 现场：模块没发 ready）——推进握手时限
      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 1000)
      await settle()

      // 用户可见结果：骨架退场，失败卡登场，且带人话与可报障的请求编号
      expect(handshaking(wrapper)).toBe(false)
      const card = failureCard(wrapper)
      expect(card.exists()).toBe(true)
      expect(card.text()).toContain('模块加载超时')
      expect(card.text()).toMatch(/请求编号：\S+/)
      // 没有 ready 就不该去取 token（壳的契约：收到 ready 才取）
      expect(fetchModuleToken).not.toHaveBeenCalled()

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('停用→启用后点 hello：重挂握手，模块发 ready 即就位（身份行可交互，不是永久骨架）', async () => {
    vi.mocked(fetchModuleToken).mockResolvedValue(TOKEN)
    vi.mocked(fetchMe).mockResolvedValue(meOk({ id: 'u1', name: '黄一' }))
    vi.mocked(fetchEnabledModules).mockResolvedValue([MODULE])

    const wrapper = await mountApp()
    await settle()

    // 第一轮：模块被停用期间 ready 到达但 token 被服务端 403 拒（停用真值在服务端）
    const first = wrapper.find('iframe').element as HTMLIFrameElement
    vi.mocked(fetchModuleToken).mockRejectedValueOnce(
      Object.assign(new Error('此模块已停用'), { status: 403 }),
    )
    dispatchReady(first)
    await settle()
    expect(failureCard(wrapper).text()).toContain('此模块已停用')

    // 管理员把 hello 重新启用；用户回工作台点 hello——
    // 此时 selectedId 本来就是 hello（落地即选它），点击不能是 no-op，必须重挂一次握手
    const beforeReload = wrapper.find('iframe').element as HTMLIFrameElement
    await navButton(wrapper, 'hello')!.trigger('click')
    await settle()

    const afterReload = wrapper.find('iframe').element as HTMLIFrameElement
    expect(afterReload).not.toBe(beforeReload) // 真的重挂了，不是原帧干等
    expect(afterReload.getAttribute('src')).toBe('/m/hello/')
    expect(failureCard(wrapper).exists()).toBe(false)

    // 重挂后的新帧发来 ready → 壳重新取 token → 就位（用户看到模块内容而非骨架）
    dispatchReady(afterReload)
    await settle()
    expect(handshaking(wrapper)).toBe(false)
    expect(failureCard(wrapper).exists()).toBe(false)

    wrapper.unmount()
  })

  it('同 id 再点的重挂不会叠桥：新帧 ready 只触发一次取 token', async () => {
    vi.mocked(fetchModuleToken).mockResolvedValue(TOKEN)
    vi.mocked(fetchMe).mockResolvedValue(meOk({ id: 'u1', name: '黄一' }))
    vi.mocked(fetchEnabledModules).mockResolvedValue([MODULE])

    const wrapper = await mountApp()
    await settle()

    const stale = wrapper.find('iframe').element as HTMLIFrameElement
    await navButton(wrapper, 'hello')!.trigger('click')
    await settle()

    const fresh = wrapper.find('iframe').element as HTMLIFrameElement
    expect(fresh).not.toBe(stale)

    // 重挂后的新帧发 ready → 只走一次桥：一次 ready 对应一次取 token
    // （若旧桥未拆，同一条 ready 会被两个监听器各接一次 → 取两次）
    dispatchReady(fresh)
    await settle()
    expect(fetchModuleToken).toHaveBeenCalledTimes(1)
    expect(handshaking(wrapper)).toBe(false)

    wrapper.unmount()
  })
})
