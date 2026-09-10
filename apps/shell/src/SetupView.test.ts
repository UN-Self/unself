// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import SetupView from './SetupView.vue'
// 源级样式守卫用：jsdom 环境下 import.meta.url 是 http:，不能走 fileURLToPath，
// 改用 Vite ?raw 直读 SFC 源文本（vitest 原生支持，零运行时 IO）。
import setupSource from './SetupView.vue?raw'
import { saveOidcConfig, testOidcConnection } from './lib/setup-api'

/**
 * #92 验收：单按钮三态机（测试连接 ↔ 保存并激活）——测用户可见行为，不测结构/类名。
 * 行为断言口径：页面上有没有「保存并激活」按钮（submit）、当前是哪个按钮、用户能否重测。
 */

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { token: 'tok-92' } }),
  useRouter: () => ({ replace: vi.fn() }),
}))

vi.mock('./lib/setup-api', () => ({
  testOidcConnection: vi.fn(),
  saveOidcConfig: vi.fn(),
  activateSetup: vi.fn(),
}))

const TEST_ISSUER = 'https://idp.example.com'

beforeEach(() => {
  vi.clearAllMocks()
  // /api/me 预探：不可登录 → autoActivateIfAuthed 早退，不干扰本页行为
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Vue <Transition mode="out-in"> 在 jsdom 里经 rAF 结算（vitest jsdom pretendToBeVisual 默认开）。 */
const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

async function settle() {
  await flushPromises()
  await nextTick()
  await raf()
  await raf()
  await raf()
  await flushPromises()
  await nextTick()
}

async function fillForm(wrapper: VueWrapper) {
  await wrapper.find('input[name="issuer"]').setValue(TEST_ISSUER)
  await wrapper.find('input[name="client_id"]').setValue('client-1')
  await wrapper.find('input[name="client_secret"]').setValue('secret-1')
}

function testButton(wrapper: VueWrapper) {
  return wrapper.findAll('button').find((b) => b.text().includes('测试连接'))
}

function submitButton(wrapper: VueWrapper) {
  return wrapper.find('button[type="submit"]')
}

/** 当前可见的「动作按钮」：测试连接 / 保存并激活 二选一（同位置互斥，不并排）。 */
function actionButtons(wrapper: VueWrapper) {
  return wrapper
    .findAll('button')
    .filter((b) => b.text().includes('测试连接') || b.text().includes('保存并激活'))
}

async function clickTest(wrapper: VueWrapper) {
  const btn = testButton(wrapper)
  expect(btn).toBeDefined() // 前置：当前应处于「测试连接」态
  await btn!.trigger('click')
}

/** #95：舞台容器（同位置两态互斥的按钮行，同宽 width:100% 由 .setup-action 承载）。 */
function actionStage(wrapper: VueWrapper) {
  return wrapper.find('.setup-test-stage')
}

/**
 * #95 同宽/居中的样式源级守卫：jsdom 无 CSS 级联（#83 退场 getComputedStyle），
 * 样式回归只能在源级断言（先例：contracts theme.test.ts 对 tokens.css 的源级测试）。
 */
function setupStyleBlock() {
  return setupSource.match(/<style[\s\S]*<\/style>/)?.[0] ?? ''
}

/**
 * #95 换位动效移植守卫（源级）：beUI StatefulButton 参数必须照抄在场。
 * jsdom 无法验证动画视觉，只能在源级断言关键参数集不丢（beUI 出处注释 + linear() 采样）。
 */
function assertSpringSwapPorted(css: string) {
  // 出处注释（starc007/ui-components · SPRING_SWAP）与采样曲线都在场
  expect(css).toMatch(/SPRING_SWAP/)
  expect(css).toMatch(/stiffness:\s*460/)
  expect(css).toMatch(/damping:\s*30/)
  expect(css).toMatch(/mass:\s*0\.55/)
  // 图标弹性缩放（beUI ICON_VARIANTS scale 0.7→1）与 outline→primary 变色 keyframe
  expect(css).toMatch(/scale\(0\.7\)/)
  expect(css).toMatch(/@keyframes setup-swap-to-primary/)
  // reduced-motion 退化在场（beUI useReducedMotion 同语义）
  expect(css).toMatch(/prefers-reduced-motion: reduce/)
}

describe('SetupView 三态机（#92）', () => {
  it('初始态：只有「测试连接」，无「保存并激活」', () => {
    const wrapper = mount(SetupView)
    expect(testButton(wrapper)).toBeDefined()
    expect(submitButton(wrapper).exists()).toBe(false)
    expect(actionButtons(wrapper).length).toBe(1)
  })

  it('#95 同宽：两态按钮共用同宽接口类（.setup-action = width:100%），不随文案内容宽变化', async () => {
    vi.mocked(testOidcConnection).mockResolvedValue({ ok: true, issuer: TEST_ISSUER, warnings: [] })
    const wrapper = mount(SetupView)
    await fillForm(wrapper)

    // 初始态：「测试连接」挂同宽接口类（不再内容宽度 ~114px 居左）
    expect(testButton(wrapper)!.classes()).toContain('setup-action')

    // 通过态：「保存并激活」挂同一个同宽接口类（两态宽度对称）
    await clickTest(wrapper)
    await settle()
    expect(submitButton(wrapper).classes()).toContain('setup-action')

    // 源级守卫：同宽规则本身存在且拉满（防类名在、规则丢）
    const css = setupStyleBlock()
    expect(css).toMatch(/\.setup-action\s*\{[^}]*width:\s*100%/)
  })

  it('#95 结果文字在按钮下方：结果行是按钮行的后继兄弟且居中（纵向排布）', async () => {
    const reason = '无法访问该 Issuer'
    vi.mocked(testOidcConnection).mockResolvedValue({ ok: false, reason })
    const wrapper = mount(SetupView)
    await fillForm(wrapper)

    await clickTest(wrapper)
    await settle()

    // 用户可见：结果文字在按钮下方（DOM 序 = 阅读序：舞台行在前、结果行在后）
    const container = wrapper.find('.setup-test')
    expect(container.exists()).toBe(true)
    const result = container.find('[role="status"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain(reason)
    const children = Array.from(container.element.children)
    expect(children[children.length - 1]).toBe(result.element)
    expect(actionStage(wrapper).exists()).toBe(true)

    // 源级守卫：纵向排布 + 结果居中规则存在（防退回横排并排）
    const css = setupStyleBlock()
    expect(css).toMatch(/\.setup-test\s*\{[^}]*flex-direction:\s*column/)
    expect(css).toMatch(/\.setup-test-result\s*\{[^}]*text-align:\s*center/)
  })

  it('#95 动效参数照抄：beUI SPRING_SWAP/图标缩放/变色都在场，reduced-motion 退化在场', () => {
    assertSpringSwapPorted(setupStyleBlock())
  })

  it('测试通过：同位置替换为「保存并激活」，并报「连接成功」', async () => {
    vi.mocked(testOidcConnection).mockResolvedValue({ ok: true, issuer: TEST_ISSUER, warnings: [] })
    const wrapper = mount(SetupView)
    await fillForm(wrapper)

    await clickTest(wrapper)
    await settle()

    // 用户可见：测试连接按钮退场，出现提交按钮——且任一时刻只有一个动作按钮（同位置替换，不并排）
    expect(testButton(wrapper)).toBeUndefined()
    expect(submitButton(wrapper).exists()).toBe(true)
    expect(submitButton(wrapper).text()).toContain('保存并激活')
    expect(actionButtons(wrapper).length).toBe(1)
    expect(wrapper.find('[role="status"]').text()).toContain('连接成功')
  })

  it('测试失败：留在「测试连接」+ 错误提示，不出提交按钮', async () => {
    const reason = '无法访问该 Issuer：请检查地址是否正确或网络可达性'
    vi.mocked(testOidcConnection).mockResolvedValue({ ok: false, reason })
    const wrapper = mount(SetupView)
    await fillForm(wrapper)

    await clickTest(wrapper)
    await settle()

    expect(testButton(wrapper)).toBeDefined()
    expect(submitButton(wrapper).exists()).toBe(false)
    expect(wrapper.find('[role="status"]').text()).toContain(reason)
  })

  it('测试通过后改任意字段：回「测试连接」，测试结果作废', async () => {
    vi.mocked(testOidcConnection).mockResolvedValue({ ok: true, issuer: TEST_ISSUER, warnings: [] })
    const wrapper = mount(SetupView)
    await fillForm(wrapper)
    await clickTest(wrapper)
    await settle()
    expect(submitButton(wrapper).exists()).toBe(true)

    await wrapper.find('input[name="client_id"]').setValue('client-2')
    await settle()

    expect(submitButton(wrapper).exists()).toBe(false)
    expect(testButton(wrapper)).toBeDefined()
    // 旧的成功提示不再展示（结果已失效）
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })

  it('测试在途时改字段：迟到的测试结果作废，不回「保存并激活」', async () => {
    let resolveTest!: (v: { ok: true; issuer: string; warnings: string[] }) => void
    vi.mocked(testOidcConnection).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveTest = resolve
      }),
    )
    const wrapper = mount(SetupView)
    await fillForm(wrapper)

    await clickTest(wrapper)
    await flushPromises()
    // 测试在途：用户改了 issuer
    await wrapper.find('input[name="issuer"]').setValue('https://changed.example.com')
    resolveTest({ ok: true, issuer: TEST_ISSUER, warnings: [] })
    await settle()

    expect(submitButton(wrapper).exists()).toBe(false)
    expect(testButton(wrapper)).toBeDefined()
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })

  it('提交失败：回「测试连接」+ 错误卡，可再次测试通过', async () => {
    vi.mocked(testOidcConnection).mockResolvedValue({ ok: true, issuer: TEST_ISSUER, warnings: [] })
    vi.mocked(saveOidcConfig).mockRejectedValue(
      Object.assign(new Error('网络不可用，请检查连接后重试'), { status: 0 }),
    )
    const wrapper = mount(SetupView)
    await fillForm(wrapper)
    await clickTest(wrapper)
    await settle()

    await wrapper.find('form').trigger('submit')
    await settle()

    // 提交失败的用户可见结果：错误卡 + 回到「测试连接」（不僵在 loading）
    expect(wrapper.find('[role="alert"]').text()).toContain('激活没有成功')
    expect(submitButton(wrapper).exists()).toBe(false)
    expect(testButton(wrapper)).toBeDefined()
    const btn = testButton(wrapper)!
    expect(btn.attributes('aria-busy')).toBeUndefined()

    // 可重测：再次测试成功 → 「保存并激活」回归
    vi.mocked(testOidcConnection).mockResolvedValue({ ok: true, issuer: TEST_ISSUER, warnings: [] })
    await clickTest(wrapper)
    await settle()
    expect(submitButton(wrapper).exists()).toBe(true)
  })
})
