// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import WizardApp from '../web/src/app'
import type { WizardEventDto } from '../web/src/lib/activity-projection'

/**
 * 根组件状态链测试（真实 /api/state 链，非模板文本）：
 * - failed 但第⑧步已注册激活入口 → 独立入口卡可见（result 深链 / 事件流兜底）；
 * - done → 完成屏展示 result 深链 + 复制；
 * - ?step= 渲染回退只到已完成步。
 * fetch 全 stub；不 mock 组件内部。
 */

const HINT = { hasEnvToken: false, oauthUsable: true, needsTotalTls: false, ci: false }

function stateOf(over: Record<string, unknown>): Record<string, unknown> {
  return {
    step: 'ready',
    instancePath: '/tmp/demo/unself',
    hasToken: true,
    domainChoice: 'workers',
    domain: '',
    modules: ['hello'],
    storageOptions: [],
    moduleAdds: [],
    moduleConfigs: [],
    configValues: {},
    resourceNames: [],
    storageChoices: {},
    sharedConsent: false,
    events: [],
    error: null,
    result: null,
    hasEnv: false,
    envHint: HINT,
    credentialSource: null,
    idempotent: true,
    ...over,
  }
}

let fetchMock: ReturnType<typeof vi.fn>
function stubState(state: Record<string, unknown>): void {
  fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.includes('/api/meta')) {
      return new Response(JSON.stringify({ tokenDeepLink: 'https://dash.example.com/t', themeVars: '' }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(state), { headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('向导根组件：/api/state 真实状态链', () => {
  it('failed 且第⑧步已生成一次性链接（事件流）→ 独立激活入口卡可见并可点', async () => {
    const events: WizardEventDto[] = [
      { i: 0, kind: 'log', text: '[7/9] 写入 OIDC ✓' },
      { i: 1, kind: 'log', text: '[8/9] 生成一次性激活链接： https://demo.example.com/setup?token=tok8' },
      { i: 2, kind: 'log', text: '✗ [9/9] 冒烟失败：健康检查超时' },
    ]
    stubState(
      stateOf({
        step: 'failed',
        result: null,
        error: { cause: '冒烟超时', owner: 'network', fix: '重跑幂等收敛' },
        events,
      }),
    )
    const wrapper = mount(WizardApp)
    await flushPromises()
    await flushPromises()

    const card = wrapper.find('[data-test=deployment-link-warning]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('入口已注册，可先继续')
    expect(card.text()).toContain('https://demo.example.com/setup?token=tok8')
    const anchor = card.find('a')
    expect(anchor.attributes('href')).toBe('https://demo.example.com/setup?token=tok8')
    // 失败三要素卡同屏
    expect(wrapper.text()).toContain('装配失败')
  })

  it('failed 且 result.setupUrl 已回写 → 入口链优先取 result（baseUrl+setupUrl）', async () => {
    stubState(
      stateOf({
        step: 'failed',
        result: { baseUrl: 'https://result.example.com', setupUrl: '/setup?token=rt' },
        error: { cause: '冒烟超时', owner: 'network', fix: '重跑幂等收敛' },
        events: [{ i: 0, kind: 'log', text: '✗ 卡住' }],
      }),
    )
    const wrapper = mount(WizardApp)
    await flushPromises()
    await flushPromises()
    const card = wrapper.find('[data-test=deployment-link-warning]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('https://result.example.com/setup?token=rt')
  })

  it('ready（无事件无链接）→ 无独立入口卡（不误显示）', async () => {
    stubState(stateOf({ step: 'ready' }))
    const wrapper = mount(WizardApp)
    await flushPromises()
    await flushPromises()
    expect(wrapper.find('[data-test=deployment-link-warning]').exists()).toBe(false)
  })

  it('done → 完成屏渲染 result 深链与「打开激活页」；步进器指向完成', async () => {
    stubState(stateOf({ step: 'done', result: { baseUrl: 'https://x.example.com', setupUrl: '/setup?token=t9' } }))
    const wrapper = mount(WizardApp)
    await flushPromises()
    await flushPromises()
    // data-test 落在 UResultCard 根：链接码文本以卡片内 code 精确断言
    expect(wrapper.find('[data-test=activation-link] code').text()).toBe('https://x.example.com/setup?token=t9')
    expect(wrapper.find('[data-test=open-activation]').attributes('href')).toBe('https://x.example.com/setup?token=t9')
    expect(wrapper.text()).toContain('装配完成')
  })

  it('?step=domain（storage 步回退）→ 根组件切视图渲染②屏且不 POST', async () => {
    window.history.replaceState(null, '', '/?step=domain')
    try {
      stubState(stateOf({ step: 'storage' }))
      const wrapper = mount(WizardApp)
      await flushPromises()
      await flushPromises()
      expect(wrapper.find('[data-screen=domain]').exists()).toBe(true)
      const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
      expect(posts).toHaveLength(0)
    } finally {
      window.history.replaceState(null, '', '/')
    }
  })
})
