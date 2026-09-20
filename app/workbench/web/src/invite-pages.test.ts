// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { Component } from 'vue'

import ActivateView from './ActivateView.vue'
import InviteView from './InviteView.vue'
import {
  activateAccount,
  claimInviteActivation,
  fetchActivation,
  fetchInvite,
  fetchInviteStatus,
  submitInvite,
} from './lib/invite-api'

/**
 * #18 公开填表 / 激活页行为测试（docs/testing.md 两问检验）：
 * 断言用户可见行为与真实网络副作用——请求是否发出、参数、状态切换、路由变化，
 * 不断言 DOM 结构/类名。
 *
 * 两处例外，属产品约束本身而非装饰：
 * - 「等待审批」态是提交成功后的用户可见结果（会不会再提交一次，靠状态守）；
 * - 激活页「邮箱密码 ≠ 工作台登录密码」两句是 2026-09-10 拍板口径（SPEC §5.7，
 *   Unself 不做密码同步），文案即语义，逐字守卫（改口径必须同时改测试）。
 */

vi.mock('./lib/invite-api', () => ({
  fetchInvite: vi.fn(),
  submitInvite: vi.fn(),
  fetchActivation: vi.fn(),
  activateAccount: vi.fn(),
  fetchInviteStatus: vi.fn(),
  claimInviteActivation: vi.fn(),
}))

/** fetchInviteStatus 缺省放行：避免无关用例误触状态查询时红（#149 缺省有邮件实例）。 */
beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  vi.mocked(fetchInviteStatus).mockResolvedValue({ status: 'pending', mailEnabled: true })
})

afterEach(() => {
  document.body.innerHTML = ''
})

/** 真实内存路由挂三页：待测页 + /login（「去登录」的目标）+ /activate/:token（claim 落点）。 */
async function mountPage(path: string, component: Component) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/invite/:token', component: InviteView },
      { path: '/activate/:token', component: ActivateView },
      { path: '/login', component: { template: '<div data-test="login-page" />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(component, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return { wrapper, router }
}

const EMPTY_INVITE = { displayName: '', emailPrefix: '', personalEmail: '' }
const WORK_EMAIL = 'zhangsan@example.net'

describe('InviteView 公开填表页（#18）', () => {
  it('①加载后提交 → submitInvite 收到三字段 → 进入审批中状态视图', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(EMPTY_INVITE)
    vi.mocked(submitInvite).mockResolvedValue(undefined)
    vi.mocked(fetchInviteStatus).mockResolvedValue({ status: 'pending', mailEnabled: true })
    const { wrapper } = await mountPage('/invite/tok-1', InviteView)

    expect(fetchInvite).toHaveBeenCalledWith('tok-1')

    await wrapper.find('input[name="display_name"]').setValue('张三')
    await wrapper.find('input[name="username"]').setValue('zhangsan')
    await wrapper.find('input[name="password"]').setValue('password123')
    await wrapper.find('input[name="password_confirm"]').setValue('password123')
    await wrapper.find('input[name="email_prefix"]').setValue('zhangsan')
    await wrapper.find('input[name="personal_email"]').setValue('zhangsan@example.net')
    await wrapper.find('form').trigger('submit')
    // pk1：提交路径里有 210k 次 PBKDF2（~80ms 原生异步），flushPromises 排不空——等它真完成
    await vi.waitFor(() => expect(submitInvite).toHaveBeenCalled())

    expect(submitInvite).toHaveBeenCalledWith('tok-1', {
      displayName: '张三',
      emailPrefix: 'zhangsan',
      personalEmail: 'zhangsan@example.net',
      username: 'zhangsan',
      salt: expect.stringMatching(/^[A-Za-z0-9+/]{22}==$/),
      proof: expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/),
    })
    expect(wrapper.text()).toContain('管理员审批中')
    expect(wrapper.text()).toContain('申请已提交')
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('②链接失效（410 人话，表单与状态查询双失败）→ 渲染错误卡且含人话，无表单', async () => {
    const message = '邀请链接已失效，请联系管理员'
    const failure = Object.assign(new Error(message), { status: 410 })
    vi.mocked(fetchInvite).mockRejectedValue(failure)
    vi.mocked(fetchInviteStatus).mockRejectedValue(failure)
    const { wrapper } = await mountPage('/invite/tok-1', InviteView)

    // 链接失效时先查表单再查状态，两处都失败才落到错误卡
    expect(fetchInviteStatus).toHaveBeenCalledWith('tok-1')
    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('邀请链接不可用')
    expect(alert.text()).toContain(message)
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('③三字段缺一 → submitInvite 不被调用，行内提示可见', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(EMPTY_INVITE)
    const { wrapper } = await mountPage('/invite/tok-1', InviteView)

    await wrapper.find('input[name="display_name"]').setValue('张三')
    await wrapper.find('input[name="email_prefix"]').setValue('zhangsan')
    // personal_email 故意留空
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(submitInvite).not.toHaveBeenCalled()
    expect(wrapper.find('form').exists()).toBe(true)
    const inline = wrapper.findAll('[role="alert"]').map((a) => a.text())
    expect(inline.some((t) => t.includes('请填写个人邮箱'))).toBe(true)
  })

  it('⑧提交在途：按钮禁用/loading，不重复提交', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(EMPTY_INVITE)
    let resolveSubmit!: () => void
    vi.mocked(submitInvite).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve
        }),
    )
    const { wrapper } = await mountPage('/invite/tok-1', InviteView)

    await wrapper.find('input[name="display_name"]').setValue('张三')
    await wrapper.find('input[name="username"]').setValue('zhangsan')
    await wrapper.find('input[name="password"]').setValue('password123')
    await wrapper.find('input[name="password_confirm"]').setValue('password123')
    await wrapper.find('input[name="email_prefix"]').setValue('zhangsan')
    await wrapper.find('input[name="personal_email"]').setValue('zhangsan@example.net')
    await wrapper.find('form').trigger('submit')
    // pk1：提交路径里有 210k 次 PBKDF2（~80ms 原生异步），flushPromises 排不空——等它真完成
    await vi.waitFor(() => expect(submitInvite).toHaveBeenCalled())

    const button = wrapper.find('button[type="submit"]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-busy')).toBe('true')

    // 在途再点也发不出第二次请求（仍只有一次提交）
    await button.trigger('click')
    await flushPromises()
    expect(submitInvite).toHaveBeenCalledTimes(1)

    resolveSubmit()
    await flushPromises()
    expect(wrapper.text()).toContain('管理员审批中')
    expect(wrapper.text()).toContain('申请已提交')
    expect(wrapper.find('form').exists()).toBe(false)
  })
})

describe('invite-api 错误/请求口径（与后端契约对齐，走真实实现）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('非 2xx：message 优先取后端 error 字段，status 透传', async () => {
    const api = await vi.importActual<typeof import('./lib/invite-api')>('./lib/invite-api')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: '邀请链接已过期或已被使用' }), { status: 410 }),
      ),
    )

    await expect(api.fetchInvite('tok-1')).rejects.toMatchObject({
      message: '邀请链接已过期或已被使用',
      status: 410,
    })
  })

  it('非 2xx 且响应体拿不到 error → 请求失败（<status>）', async () => {
    const api = await vi.importActual<typeof import('./lib/invite-api')>('./lib/invite-api')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 500 })))

    await expect(api.fetchInvite('tok-1')).rejects.toThrow('请求失败（500）')
  })

  it('网络异常 → 网络不可用，请检查连接后重试', async () => {
    const api = await vi.importActual<typeof import('./lib/invite-api')>('./lib/invite-api')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await expect(api.fetchActivation('tok-2')).rejects.toThrow('网络不可用，请检查连接后重试')
  })

  it('提交走 POST 且路径令牌编码、body 为契约字段', async () => {
    const api = await vi.importActual<typeof import('./lib/invite-api')>('./lib/invite-api')
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, loginHint: 'hint' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const application = { displayName: '张三', emailPrefix: 'zhangsan', personalEmail: 'z@example.net' }
    await api.submitInvite('tok/a b', application)
    await api.activateAccount('tok-2', 'Str0ng-Pass')

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/invite/tok%2Fa%20b', {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(application),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/activate/tok-2', {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'Str0ng-Pass' }),
    })
  })
})

describe('ActivateView 公开激活页（#18）', () => {
  it('④加载带 token 取工作邮箱；两次密码不一致 → activateAccount 不被调用且有可见错误', async () => {
    vi.mocked(fetchActivation).mockResolvedValue({ email: WORK_EMAIL })
    const { wrapper } = await mountPage('/activate/tok-2', ActivateView)

    expect(fetchActivation).toHaveBeenCalledWith('tok-2')
    expect(wrapper.text()).toContain(WORK_EMAIL)

    await wrapper.find('input[name="password"]').setValue('password-1')
    await wrapper.find('input[name="password_confirm"]').setValue('password-2')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(activateAccount).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('两次输入的密码不一致')
  })

  it('④b密码不足 8 位 → 不发请求且有可见提示', async () => {
    vi.mocked(fetchActivation).mockResolvedValue({ email: WORK_EMAIL })
    const { wrapper } = await mountPage('/activate/tok-2', ActivateView)

    await wrapper.find('input[name="password"]').setValue('short-1')
    await wrapper.find('input[name="password_confirm"]').setValue('short-1')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(activateAccount).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('密码至少 8 位')
  })

  it('⑤合法两次密码 → activateAccount(token, password) → 展示 loginHint → 去登录到 /login', async () => {
    vi.mocked(fetchActivation).mockResolvedValue({ email: WORK_EMAIL })
    vi.mocked(activateAccount).mockResolvedValue({
      ok: true,
      loginHint: '请用新密码登录你的邮箱，工作台仍走团队账号。',
    })
    const { wrapper, router } = await mountPage('/activate/tok-2', ActivateView)

    await wrapper.find('input[name="password"]').setValue('Str0ng-Pass')
    await wrapper.find('input[name="password_confirm"]').setValue('Str0ng-Pass')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(activateAccount).toHaveBeenCalledWith('tok-2', 'Str0ng-Pass')
    expect(wrapper.text()).toContain('激活完成')
    expect(wrapper.text()).toContain('请用新密码登录你的邮箱，工作台仍走团队账号。')

    const loginButton = wrapper.findAll('button').find((b) => b.text().includes('去登录'))
    expect(loginButton).toBeDefined()
    await loginButton!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('⑥链接失效 → 错误卡可见且含人话，无表单', async () => {
    const message = '激活链接无效、已使用或已过期'
    vi.mocked(fetchActivation).mockRejectedValue(new Error(message))
    const { wrapper } = await mountPage('/activate/tok-2', ActivateView)

    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('激活链接不可用')
    expect(alert.text()).toContain(message)
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('⑦拍板口径守卫：文案逐字含邮箱（2026-09-10，SPEC §5.7「不做密码同步」）', async () => {
    vi.mocked(fetchActivation).mockResolvedValue({ email: WORK_EMAIL })
    const { wrapper } = await mountPage('/activate/tok-2', ActivateView)

    const text = wrapper.text()
    expect(text).toContain(`此密码用于登录你的邮箱（${WORK_EMAIL}）；若团队登录走独立 IdP，登录账户请联系管理员。`)
    expect(text).toContain('这是邮箱密码，不是工作台登录密码。')
  })
})

describe('InviteView 内置注册字段（issue-A）', () => {
  it('新必填字段渲染：用户名/密码/重复密码在显示名之后', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(EMPTY_INVITE)
    const { wrapper } = await mountPage('/invite/tok-1', InviteView)

    for (const name of ['username', 'password', 'password_confirm']) {
      expect(wrapper.find(`input[name="${name}"]`).exists()).toBe(true)
    }
  })

  it('用户名格式不符：不发请求，行内提示可见', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(EMPTY_INVITE)
    const { wrapper } = await mountPage('/invite/tok-1', InviteView)

    await wrapper.find('input[name="display_name"]').setValue('张三')
    await wrapper.find('input[name="username"]').setValue('a')
    await wrapper.find('input[name="password"]').setValue('password123')
    await wrapper.find('input[name="password_confirm"]').setValue('password123')
    await wrapper.find('input[name="email_prefix"]').setValue('zhangsan')
    await wrapper.find('input[name="personal_email"]').setValue('zhangsan@example.net')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(submitInvite).not.toHaveBeenCalled()
    const inline = wrapper.findAll('[role="alert"]').map((a) => a.text())
    expect(inline.some((t) => t.includes('用户名需为 3-32 位字母/数字/_/-'))).toBe(true)
  })

  it('重名 409：后端人话「用户名已被占用」在提交错误区可见', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(EMPTY_INVITE)
    vi.mocked(submitInvite).mockRejectedValue(
      Object.assign(new Error('用户名已被占用'), { status: 409 }),
    )
    const { wrapper } = await mountPage('/invite/tok-1', InviteView)

    await wrapper.find('input[name="display_name"]').setValue('张三')
    await wrapper.find('input[name="username"]').setValue('zhangsan')
    await wrapper.find('input[name="password"]').setValue('password123')
    await wrapper.find('input[name="password_confirm"]').setValue('password123')
    await wrapper.find('input[name="email_prefix"]').setValue('zhangsan')
    await wrapper.find('input[name="personal_email"]').setValue('zhangsan@example.net')
    await wrapper.find('form').trigger('submit')
    // pk1：等待客户端 PBKDF2 完成后再断言后端人话回显
    await vi.waitFor(() => expect(submitInvite).toHaveBeenCalled())
    await flushPromises()

    expect(wrapper.text()).toContain('用户名已被占用')
  })
})

describe('InviteView 状态化三态（#134）', () => {
  /** 已提交的链接重开：表单读不回（410），直接进入状态轮询视图。 */
  async function mountSubmittedView() {
    vi.mocked(fetchInvite).mockRejectedValue(
      Object.assign(new Error('邀请链接已过期或已被使用'), { status: 410 }),
    )
    return mountPage('/invite/tok-1', InviteView)
  }

  it('⑨已提交链接重开 + status=pending → 审批中视图 + 手动刷新按钮；刷新翻到 approved', async () => {
    vi.mocked(fetchInviteStatus).mockResolvedValue({ status: 'pending', mailEnabled: true })
    const { wrapper } = await mountSubmittedView()

    expect(fetchInviteStatus).toHaveBeenCalledWith('tok-1')
    expect(wrapper.text()).toContain('管理员审批中')
    expect(wrapper.text()).toContain('申请已提交')
    expect(wrapper.find('form').exists()).toBe(false)

    // 手动刷新：status 翻 approved → 大按钮视图
    vi.mocked(fetchInviteStatus).mockResolvedValue({ status: 'approved', mailEnabled: true })
    const refresh = wrapper.find('[data-test="refresh-status"]')
    expect(refresh.exists()).toBe(true)
    await refresh.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('管理员已批准')
    expect(wrapper.text()).toContain('设置你的邮箱密码')
    expect(wrapper.find('[data-test="claim-activation"]').exists()).toBe(true)
  })

  it('⑩approved 态点大按钮 → claim → 跳转 activationUrl 指向的激活页', async () => {
    vi.mocked(fetchInviteStatus).mockResolvedValue({ status: 'approved', mailEnabled: true })
    // 服务端回同源绝对地址（部署常态）；测试里用运行时 origin 拼接
    const activationUrl = `${window.location.origin}/activate/tok-activation`
    vi.mocked(claimInviteActivation).mockResolvedValue({ activationUrl })
    const { wrapper, router } = await mountSubmittedView()

    const claim = wrapper.find('[data-test="claim-activation"]')
    expect(claim.exists()).toBe(true)
    expect(claim.text()).toContain('设置邮箱密码')
    await claim.trigger('click')
    await flushPromises()

    expect(claimInviteActivation).toHaveBeenCalledWith('tok-1')
    expect(router.currentRoute.value.path).toBe('/activate/tok-activation')
  })

  it('⑩bclaim 409「已激活过」→ 状态刷新把视图带到全部就绪（服务端人话即终态指引）', async () => {
    vi.mocked(fetchInviteStatus)
      .mockResolvedValueOnce({ status: 'approved', mailEnabled: true })
      .mockResolvedValue({ status: 'activated', mailEnabled: true })
    vi.mocked(claimInviteActivation).mockRejectedValue(
      Object.assign(new Error('已激活过，请直接登录'), { status: 409 }),
    )
    const { wrapper } = await mountSubmittedView()

    await wrapper.find('[data-test="claim-activation"]').trigger('click')
    await flushPromises()

    // 「已激活过」的正确响应就是全部就绪视图：不再显示大按钮，直接引导去登录
    expect(wrapper.text()).toContain('全部就绪')
    expect(wrapper.text()).toContain('使用邮箱与密码登录')
    expect(wrapper.find('[data-test="claim-activation"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="go-login"]').exists()).toBe(true)
  })

  it('⑪activated 态 → 全部就绪视图 + 去登录按钮跳 /login', async () => {
    vi.mocked(fetchInviteStatus).mockResolvedValue({ status: 'activated', mailEnabled: true })
    const { wrapper, router } = await mountSubmittedView()

    expect(wrapper.text()).toContain('全部就绪')
    expect(wrapper.text()).toContain('使用邮箱与密码登录')

    const login = wrapper.find('[data-test="go-login"]')
    expect(login.exists()).toBe(true)
    await login.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('⑫轮询口径：pending 5s 后自动重查、approved/activated/错误即停（无死循环）', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchInviteStatus).mockResolvedValue({ status: 'pending', mailEnabled: true })
      const { wrapper } = await mountSubmittedView()
      expect(fetchInviteStatus).toHaveBeenCalledTimes(1)

      // pending：5s 一拍，自动重查
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetchInviteStatus).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetchInviteStatus).toHaveBeenCalledTimes(3)

      // 翻 approved → 停拍
      vi.mocked(fetchInviteStatus).mockResolvedValue({ status: 'approved', mailEnabled: true })
      await vi.advanceTimersByTimeAsync(5000)
      const callsAfterApproved = vi.mocked(fetchInviteStatus).mock.calls.length
      expect(callsAfterApproved).toBe(4)
      expect(wrapper.text()).toContain('管理员已批准')
      await vi.advanceTimersByTimeAsync(20000)
      expect(vi.mocked(fetchInviteStatus).mock.calls.length).toBe(callsAfterApproved)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('InviteView 无邮件实例（#149 mailEnabled=false）', () => {
  /** 已提交的链接重开（410）：与三态用例同路径，由 status 响应驱动视图。 */
  function mockSubmittedLink() {
    vi.mocked(fetchInvite).mockRejectedValue(
      Object.assign(new Error('邀请链接已过期或已被使用'), { status: 410 }),
    )
  }

  it('⑬无邮件实例表单：无邮箱两字段；提交 body 键集不含 emailPrefix/personalEmail', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(EMPTY_INVITE)
    vi.mocked(submitInvite).mockResolvedValue(undefined)
    vi.mocked(fetchInviteStatus).mockResolvedValue({ status: 'pending', mailEnabled: false })
    const { wrapper } = await mountPage('/invite/tok-1', InviteView)

    // 表单不渲染邮箱字段
    expect(wrapper.find('input[name="email_prefix"]').exists()).toBe(false)
    expect(wrapper.find('input[name="personal_email"]').exists()).toBe(false)

    await wrapper.find('input[name="display_name"]').setValue('张三')
    await wrapper.find('input[name="username"]').setValue('zhangsan')
    await wrapper.find('input[name="password"]').setValue('password123')
    await wrapper.find('input[name="password_confirm"]').setValue('password123')
    await wrapper.find('form').trigger('submit')
    // pk1：等待 PBKDF2 完成后再断言提交载荷
    await vi.waitFor(() => expect(submitInvite).toHaveBeenCalled())

    // 比 toHaveBeenCalledWith 更硬：直接断言 body 键集完全不带这两个键
    expect(submitInvite).toHaveBeenCalledTimes(1)
    const body = vi.mocked(submitInvite).mock.calls[0]![1] as Record<string, unknown>
    expect(Object.keys(body)).not.toContain('emailPrefix')
    expect(Object.keys(body)).not.toContain('personalEmail')
    expect(body.displayName).toBe('张三')
    expect(body.username).toBe('zhangsan')
    // 提交后 pending：无邮件文案不承诺「设置邮箱密码」入口
    expect(wrapper.text()).toContain('管理员批准后即可直接登录')
  })

  it('⑭无邮件实例 approved：批准即激活 →「全部就绪」视图，无设密入口，去登录跳 /login', async () => {
    mockSubmittedLink()
    vi.mocked(fetchInviteStatus).mockResolvedValue({ status: 'approved', mailEnabled: false })
    const { wrapper, router } = await mountPage('/invite/tok-1', InviteView)

    expect(wrapper.text()).toContain('全部就绪')
    expect(wrapper.text()).toContain('账号已激活，请前往登录页登录。')
    expect(wrapper.text()).not.toContain('设置邮箱密码')
    expect(wrapper.find('[data-test="claim-activation"]').exists()).toBe(false)

    const login = wrapper.find('[data-test="go-login"]')
    expect(login.exists()).toBe(true)
    await login.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('⑮无邮件实例 activated：同「全部就绪」视图，不出现「邮箱密码已设置完成」', async () => {
    mockSubmittedLink()
    vi.mocked(fetchInviteStatus).mockResolvedValue({ status: 'activated', mailEnabled: false })
    const { wrapper } = await mountPage('/invite/tok-1', InviteView)

    expect(wrapper.text()).toContain('全部就绪')
    expect(wrapper.text()).toContain('账号已激活，请前往登录页登录。')
    expect(wrapper.text()).not.toContain('邮箱密码已设置完成')
    expect(wrapper.find('[data-test="go-login"]').exists()).toBe(true)
  })

  it('⑯无邮件实例 pending：审批中文案不含「设置邮箱密码」承诺', async () => {
    mockSubmittedLink()
    vi.mocked(fetchInviteStatus).mockResolvedValue({ status: 'pending', mailEnabled: false })
    const { wrapper } = await mountPage('/invite/tok-1', InviteView)

    expect(wrapper.text()).toContain('管理员审批中')
    expect(wrapper.text()).toContain('管理员批准后即可直接登录')
    expect(wrapper.text()).not.toContain('设置邮箱密码')
  })
})
