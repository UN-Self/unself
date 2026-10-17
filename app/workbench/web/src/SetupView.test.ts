// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import SetupView from './SetupView.vue'

const routerReplace = vi.fn()
const query = vi.hoisted(() => ({ token: 'tok-92' as string | undefined }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query }),
  useRouter: () => ({ replace: routerReplace }),
}))

// 仅替换网络、浏览器导航与 WebCrypto 环境；真实执行组件、API 客户端和密码派生。
const ISSUER = 'https://idp.example.com'
const TEST = '/api/oidc/test-connection'
const SAVE = '/api/setup/oidc-config'
const CREATE = '/api/setup/builtin-admin'
const LOGIN = '/api/auth/login'
const assign = vi.fn()
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
let respond: (path: string, init?: RequestInit) => Promise<Response>

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, headers: new Headers(), json: async () => body } as Response
}

async function defaultResponse(path: string): Promise<Response> {
  switch (path) {
    case TEST: return json({ ok: true, issuer: ISSUER })
    case SAVE: return json({ ok: true, loginUrl: LOGIN })
    case CREATE: return json({ ok: true, user: { id: 'admin', name: 'boss', role: 'admin' } }, 201)
    case '/api/auth/salt': return json({ salt: 'AAAAAAAAAAAAAAAAAAAAAA==' })
    case LOGIN: return json({ ok: true })
    default: throw new Error(`未预期的请求：${path}`)
  }
}

function requests(path: string) {
  return fetchMock.mock.calls.filter(([url]) => new URL(String(url), 'https://team.example.com').pathname === path)
}

beforeEach(() => {
  vi.resetAllMocks()
  query.token = 'tok-92'
  respond = defaultResponse
  fetchMock.mockImplementation((url, init) => respond(new URL(String(url), 'https://team.example.com').pathname, init))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('location', { ...window.location, assign })
})

afterEach(() => vi.unstubAllGlobals())

async function settle() {
  await flushPromises()
  await nextTick()
  for (let frame = 0; frame < 3; frame++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  await flushPromises()
}

async function fillOidc(wrapper: VueWrapper) {
  await editBranch(wrapper, 'oidc')
  await wrapper.get('input[name="issuer"]').setValue(ISSUER)
  await wrapper.get('input[name="client_id"]').setValue('client-1')
  await wrapper.get('input[name="client_secret"]').setValue('secret-1')
}

async function fillAdmin(wrapper: VueWrapper, confirmation = 'password123') {
  await editBranch(wrapper, 'admin')
  await wrapper.get('input[name="username"]').setValue('boss')
  await wrapper.get('input[name="password"]').setValue('password123')
  await wrapper.get('input[name="password_confirm"]').setValue(confirmation)
}

async function testConnection(wrapper: VueWrapper) {
  await editBranch(wrapper, 'oidc')
  await wrapper.get('[data-testid="oidc-test"]').trigger('click')
  await settle()
}

async function prepareOidc(wrapper: VueWrapper) {
  await fillOidc(wrapper)
  await testConnection(wrapper)
}

async function submit(wrapper: VueWrapper, branch: 'admin' | 'oidc') {
  await editBranch(wrapper, branch)
  await wrapper.get(`[data-testid="${branch}-form"]`).trigger('submit')
  await settle()
}

/** 通过可见的翻页入口切到目标页；已在目标页时那一下点击无副作用（两侧翻页函数各自带当前页/提交中判断）。 */
async function editBranch(wrapper: VueWrapper, branch: 'admin' | 'oidc') {
  await wrapper.get(`[data-testid="${branch === 'oidc' ? 'open-oidc' : 'return-admin'}"]`).trigger('click')
  await settle()
}

function expectNoCompletion() {
  expect(requests(CREATE)).toHaveLength(0)
  expect(requests(LOGIN)).toHaveLength(0)
  expect(assign).not.toHaveBeenCalled()
  expect(routerReplace).not.toHaveBeenCalled()
}

describe('SetupView 初始化边界（#332）', () => {
  it.each([false, true])('打开页面不因会话状态自动写入或导航（已有会话：%s）', async (hasSession) => {
    respond = async (path) => path === '/api/me' ? json({}, hasSession ? 200 : 401) : defaultResponse(path)
    mount(SetupView)
    await settle()
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
    expectNoCompletion()
  })

  it('没有 token 时不能发起配置或建号请求', async () => {
    query.token = undefined
    mount(SetupView)
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    expectNoCompletion()
  })

  it.each(['empty', 'mismatch', 'valid'])('本地表单为 %s 时，OIDC 均独立保存且不完成初始化', async (adminState) => {
    const wrapper = mount(SetupView)
    if (adminState !== 'empty') await fillAdmin(wrapper, adminState === 'mismatch' ? 'different123' : 'password123')
    await prepareOidc(wrapper)
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(1)
    const [url, init] = requests(SAVE)[0]!
    expect(String(url)).toBe(`${SAVE}?token=tok-92`)
    expect(JSON.parse(init!.body as string)).toEqual({ issuer: ISSUER, clientId: 'client-1', clientSecret: 'secret-1' })
    expect(wrapper.get('[role="status"]').text()).toContain('OIDC 配置已保存')
    expectNoCompletion()
  })

  it('保存 OIDC 后，只有主动提交本地表单才建号、登录并进入工作台', async () => {
    const wrapper = mount(SetupView)
    await prepareOidc(wrapper)
    await submit(wrapper, 'oidc')
    expectNoCompletion()
    await fillAdmin(wrapper)
    await submit(wrapper, 'admin')
    await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/'))
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes.map(([url]) => new URL(String(url), 'https://team.example.com').pathname)).toEqual([TEST, SAVE, CREATE, LOGIN])
    expect(assign).not.toHaveBeenCalled()
  })

  it('OIDC 保存未完成时，重复提交不能新增保存或插入建号；结束后可继续建号', async () => {
    let finishSave!: (response: Response) => void
    respond = (path) => path === SAVE ? new Promise((resolve) => { finishSave = resolve }) : defaultResponse(path)
    const wrapper = mount(SetupView)
    await fillAdmin(wrapper)
    await prepareOidc(wrapper)
    await submit(wrapper, 'oidc')
    await submit(wrapper, 'oidc')
    await submit(wrapper, 'admin')
    expect(requests(SAVE)).toHaveLength(1)
    expectNoCompletion()
    finishSave(json({ ok: true, loginUrl: LOGIN }))
    await settle()
    expectNoCompletion()
    await submit(wrapper, 'admin')
    await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/'))
    expect(requests(CREATE)).toHaveLength(1)
  })

  it('本地建号未完成时，重复本地提交和 OIDC 保存均不新增请求', async () => {
    let finishCreate!: (response: Response) => void
    respond = (path) => path === CREATE ? new Promise((resolve) => { finishCreate = resolve }) : defaultResponse(path)
    const wrapper = mount(SetupView)
    await fillAdmin(wrapper)
    await prepareOidc(wrapper)
    await submit(wrapper, 'admin')
    await vi.waitFor(() => expect(requests(CREATE)).toHaveLength(1))
    await submit(wrapper, 'admin')
    await submit(wrapper, 'oidc')
    expect(requests(CREATE)).toHaveLength(1)
    expect(requests(SAVE)).toHaveLength(0)
    finishCreate(json({ ok: true, user: { id: 'admin', name: 'boss', role: 'admin' } }, 201))
    await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/'))
    expect(requests(LOGIN)).toHaveLength(1)
  })

  it('保存失败后必须重测，再次保存会实际发出请求并成功', async () => {
    respond = (path) => path === SAVE && requests(SAVE).length === 1
      ? Promise.resolve(json({ error: 'save failed' }, 503)) : defaultResponse(path)
    const wrapper = mount(SetupView)
    await prepareOidc(wrapper)
    await submit(wrapper, 'oidc')
    expect(wrapper.get('[role="alert"]').text()).toContain('服务尚未就绪')
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(1)
    await testConnection(wrapper)
    await submit(wrapper, 'oidc')
    expect(requests(TEST)).toHaveLength(2)
    expect(requests(SAVE)).toHaveLength(2)
    expect(wrapper.get('[role="status"]').text()).toContain('OIDC 配置已保存')
    expectNoCompletion()
  })

  it('管理员已建但登录失败：只重试登录，不重复建号或保存 OIDC', async () => {
    respond = (path) => path === LOGIN && requests(LOGIN).length === 1
      ? Promise.resolve(json({ error: '登录暂时不可用' }, 503)) : defaultResponse(path)
    const wrapper = mount(SetupView)
    await fillAdmin(wrapper)
    await prepareOidc(wrapper)
    await submit(wrapper, 'admin')
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain('管理员账号已创建'))
    expect(routerReplace).not.toHaveBeenCalled()
    await submit(wrapper, 'admin')
    await submit(wrapper, 'oidc')
    expect(requests(CREATE)).toHaveLength(1)
    expect(requests(SAVE)).toHaveLength(0)
    await wrapper.get('[data-testid="admin-login-error"]').get('button').trigger('click')
    await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/'))
    expect(requests(CREATE)).toHaveLength(1)
    expect(requests(LOGIN)).toHaveLength(2)
  })
})

describe('SetupView 卡片翻页动线', () => {
  it('翻页与手动返回保留两份输入，切换本身不发起写请求', async () => {
    const wrapper = mount(SetupView)
    await fillAdmin(wrapper)
    await fillOidc(wrapper)
    await editBranch(wrapper, 'admin')
    expect((wrapper.get('input[name="username"]').element as HTMLInputElement).value).toBe('boss')
    expect((wrapper.get('input[name="password"]').element as HTMLInputElement).value).toBe('password123')
    await editBranch(wrapper, 'oidc')
    expect((wrapper.get('input[name="issuer"]').element as HTMLInputElement).value).toBe(ISSUER)
    expect((wrapper.get('input[name="client_secret"]').element as HTMLInputElement).value).toBe('secret-1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('打开时焦点进入 OIDC，Escape 返回折角入口；无效创建聚焦首个错误字段', async () => {
    const wrapper = mount(SetupView, { attachTo: document.body })
    try {
      await editBranch(wrapper, 'oidc')
      expect(document.activeElement).toBe(wrapper.get('input[name="issuer"]').element)
      await wrapper.get('input[name="issuer"]').trigger('keydown', { key: 'Escape' })
      await settle()
      expect(document.activeElement).toBe(wrapper.get('[data-testid="open-oidc"]').element)
      await wrapper.get('[data-testid="create-admin"]').trigger('click')
      await settle()
      expect(document.activeElement).toBe(wrapper.get('input[name="username"]').element)
      expectNoCompletion()
    } finally {
      wrapper.unmount()
    }
  })

  it('OIDC 页不能略过保存直接创建；保存后翻页回、聚焦创建，再点击才完成初始化', async () => {
    const wrapper = mount(SetupView, { attachTo: document.body })
    try {
      await fillAdmin(wrapper)
      await prepareOidc(wrapper)
      await wrapper.get('[data-testid="create-admin"]').trigger('click')
      await settle()
      expectNoCompletion()
      await wrapper.get('[data-testid="oidc-save"]').trigger('click')
      await settle()
      expect(requests(SAVE)).toHaveLength(1)
      expectNoCompletion()
      expect(document.activeElement).toBe(wrapper.get('[data-testid="create-admin"]').element)
      await wrapper.get('[data-testid="create-admin"]').trigger('click')
      await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/'))
      expect(requests(CREATE)).toHaveLength(1)
    } finally {
      wrapper.unmount()
    }
  })

  it('返回后隐藏的 OIDC 表单不会发起保存；重新翻页到 OIDC 页可保存', async () => {
    const wrapper = mount(SetupView)
    await prepareOidc(wrapper)
    await editBranch(wrapper, 'admin')
    await wrapper.get('[data-testid="oidc-form"]').trigger('submit')
    await settle()
    expect(requests(SAVE)).toHaveLength(0)
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(1)
  })
})

describe('SetupView OIDC 校验与测试失效', () => {
  it('未测试时直接提交不保存；测试成功后可保存', async () => {
    const wrapper = mount(SetupView)
    await fillOidc(wrapper)
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(0)
    await testConnection(wrapper)
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(1)
  })

  it.each(['issuer', 'client_id', 'client_secret'])('测试后清空 %s 不保存，修正并重测后可保存', async (field) => {
    const wrapper = mount(SetupView)
    await prepareOidc(wrapper)
    await wrapper.get(`input[name="${field}"]`).setValue('')
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(0)
    await fillOidc(wrapper)
    await testConnection(wrapper)
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(1)
  })

  it('连接失败不能保存，修复后可重测并保存', async () => {
    respond = (path) => path === TEST && requests(TEST).length === 1
      ? Promise.resolve(json({ error: 'unreachable' }, 502)) : defaultResponse(path)
    const wrapper = mount(SetupView)
    await prepareOidc(wrapper)
    expect(wrapper.get('[role="status"]').text()).toContain('无法访问该 Issuer')
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(0)
    await testConnection(wrapper)
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(1)
  })

  it.each(['issuer', 'client_id', 'client_secret'])('测试通过后修改 %s，旧结果不能用于保存', async (field) => {
    const wrapper = mount(SetupView)
    await prepareOidc(wrapper)
    await wrapper.get(`input[name="${field}"]`).setValue(field === 'issuer' ? 'https://changed.example.com' : 'changed')
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(0)
    await testConnection(wrapper)
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(1)
  })

  it.each(['issuer', 'client_id', 'client_secret'])('测试在途时修改 %s，迟到结果不能授权保存', async (field) => {
    let finishTest!: (response: Response) => void
    respond = (path) => path === TEST && requests(TEST).length === 1
      ? new Promise((resolve) => { finishTest = resolve }) : defaultResponse(path)
    const wrapper = mount(SetupView)
    await fillOidc(wrapper)
    await testConnection(wrapper)
    await wrapper.get(`input[name="${field}"]`).setValue(field === 'issuer' ? 'https://changed.example.com' : 'changed')
    finishTest(json({ ok: true, issuer: ISSUER }))
    await settle()
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(0)
    await testConnection(wrapper)
    await submit(wrapper, 'oidc')
    expect(requests(SAVE)).toHaveLength(1)
  })
})

describe('SetupView 本地管理员校验与失败恢复', () => {
  it('密码不一致不建号，修正后可完成初始化', async () => {
    const wrapper = mount(SetupView)
    await fillAdmin(wrapper, 'different123')
    await submit(wrapper, 'admin')
    expectNoCompletion()
    expect(wrapper.text()).toContain('两次输入的密码不一致')
    await wrapper.get('input[name="password_confirm"]').setValue('password123')
    await submit(wrapper, 'admin')
    await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/'))
  })

  it('用户名不合法不建号，修正后可完成初始化', async () => {
    const wrapper = mount(SetupView)
    await fillAdmin(wrapper)
    await wrapper.get('input[name="username"]').setValue('a')
    await submit(wrapper, 'admin')
    expectNoCompletion()
    expect(wrapper.text()).toContain('用户名需为 3-32 位')
    await wrapper.get('input[name="username"]').setValue('boss')
    await submit(wrapper, 'admin')
    await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/'))
  })

  it('用户名占用时不登录，换名后可重试建号', async () => {
    respond = (path) => path === CREATE && requests(CREATE).length === 1
      ? Promise.resolve(json({ error: '该用户名已被占用' }, 409)) : defaultResponse(path)
    const wrapper = mount(SetupView)
    await fillAdmin(wrapper)
    await submit(wrapper, 'admin')
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain('该用户名已被占用'))
    expect(requests(LOGIN)).toHaveLength(0)
    expect(routerReplace).not.toHaveBeenCalled()
    await wrapper.get('input[name="username"]').setValue('boss2')
    await submit(wrapper, 'admin')
    await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/'))
    expect(requests(CREATE)).toHaveLength(2)
    expect(JSON.parse(requests(CREATE)[1]![1]!.body as string)).toMatchObject({ username: 'boss2' })
  })
})
