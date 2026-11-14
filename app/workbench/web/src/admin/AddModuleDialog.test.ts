// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import { UMotionSelect } from '@unself/ui'
import AddModuleDialog from './add-module-dialog.vue'
import ModulesPage from './ModulesPage.vue'
import {
  activateConnectModule,
  fetchConnectStatus,
  generateConnectKey,
  installCloudflareModule,
  registerConnectModule,
} from '../lib/modules-install-api'
import { fetchAdminModules, toggleModule, type AdminModule } from '../lib/admin-api'
import { makeApiError } from '../lib/api-client'

/**
 * 「新增模块」双模式弹窗行为测试（#349 决策 #108/#109）。
 * 断言用户可见结果（面板切换、env 打码/明文、复制动作、tooltip、按钮可用性、错误提示、保存后列表刷新），
 * 不碰组件内部字段名。密钥相关：明文默认不出现在 DOM，只在眼睛切换后可见；生成即复制、点框再复制；请求只带哈希。
 */

vi.mock('../lib/modules-install-api', () => ({
  generateConnectKey: vi.fn(),
  registerConnectModule: vi.fn(),
  fetchConnectStatus: vi.fn(),
  activateConnectModule: vi.fn(),
  installCloudflareModule: vi.fn(),
}))

vi.mock('../lib/admin-api', () => ({
  fetchAdminModules: vi.fn(),
  toggleModule: vi.fn(),
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

/** clipboard 桩：jsdom 没有 navigator.clipboard，用可配置的 mock 替身；生成即复制/点框复制都走 writeText。 */
const clipboardWriteText = vi.fn()

async function generateKey(wrapper: ReturnType<typeof mount>) {
  await wrapper.find('[data-test="connect-id"]').setValue('bridge')
  await wrapper.find('[data-test="connect-generate"]').trigger('click')
  await flushPromises()
}

describe('AddModuleDialog（#349 双模式）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clipboard 默认成功：生成即复制会在每次生成时调用 writeText
    clipboardWriteText.mockReset()
    clipboardWriteText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboardWriteText }, configurable: true })
    vi.mocked(generateConnectKey).mockResolvedValue({ key: 'plain-key-123', keyHash: 'f'.repeat(64) })
    vi.mocked(registerConnectModule).mockResolvedValue({ id: 'bridge', mode: 'connect', enabled: false })
    vi.mocked(fetchConnectStatus).mockResolvedValue({ moduleId: 'bridge', online: true })
    vi.mocked(activateConnectModule).mockResolvedValue(mod({ id: 'bridge', mode: 'connect', entry: 'https://t/m/bridge/' }))
    vi.mocked(installCloudflareModule).mockResolvedValue(mod())
    // 重名预检的数据源：默认空列表（没有同名模块）
    vi.mocked(fetchAdminModules).mockResolvedValue([])
  })

  function mountDialog() {
    return mount(AddModuleDialog, { props: { modelValue: true } })
  }

  it('两种方式并列：默认反连，可切到 Cloudflare 部署', async () => {
    const wrapper = mountDialog()
    expect(wrapper.find('[data-test="add-module-connect"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="add-module-cloudflare"]').exists()).toBe(false)

    await wrapper.find('[data-test="add-module-tab-cloudflare"]').trigger('click')
    expect(wrapper.find('[data-test="add-module-cloudflare"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="add-module-connect"]').exists()).toBe(false)
    // CF tab 不出水（水位只属于反连测试动线）
    expect(wrapper.find('[data-level]').attributes('data-level')).toBe('rest')
  })

  it('存储落点收敛为 自托管/Core 两档，默认自托管（undefined=self）', async () => {
    // 反连 tab
    const connect = mountDialog()
    const [connectSelect] = connect.findAllComponents(UMotionSelect)
    const connectOptions = connectSelect!.props('options') as Array<{ value: string; label: string }>
    expect(connectOptions.map((o) => o.value)).toEqual(['self', 'core'])
    expect(connectOptions.map((o) => o.label)).toEqual(['自托管', 'Core'])
    // 默认选 self：注册请求 storageLevel 即 undefined（undefined=self，#349 验收定案）
    await generateKey(connect)
    expect(registerConnectModule).toHaveBeenCalledWith(
      expect.objectContaining({ storageLevel: undefined }),
    )

    // CF tab 同款收敛
    const cf = mountDialog()
    await cf.find('[data-test="add-module-tab-cloudflare"]').trigger('click')
    const [cfSelect] = cf.findAllComponents(UMotionSelect)
    const cfOptions = cfSelect!.props('options') as Array<{ value: string; label: string }>
    expect(cfOptions.map((o) => o.value)).toEqual(['self', 'core'])
    await cf.find('[data-test="cf-npmspec"]').setValue('@unself/hello@0.1.0')
    await cf.find('[data-test="cf-account"]').setValue('acc-1')
    await cf.find('[data-test="cf-token"]').setValue('cf-plain-token')
    await cf.find('[data-test="cf-install"]').trigger('click')
    await flushPromises()
    expect(installCloudflareModule).toHaveBeenCalledWith(
      expect.objectContaining({ storageLevel: undefined }),
    )
  })

  it('生成接入码：问号收进生成按钮；生成即复制明文；env 默认打码，明文不进 DOM', async () => {
    const wrapper = mountDialog()

    // 生成按钮自带问号图标 + UNSELF_CORE_URL tooltip 出处（aria-describedby）；独立问号按钮已删
    const generateBtn = wrapper.find('[data-test="connect-generate"]')
    expect(generateBtn.text()).toContain('生成接入码')
    expect(generateBtn.attributes('aria-describedby')).toBe('core-url-tip')
    expect(wrapper.find('[data-test="connect-env-help"]').exists()).toBe(false)

    await generateKey(wrapper)

    expect(registerConnectModule).toHaveBeenCalledWith({
      moduleId: 'bridge',
      keyHash: 'f'.repeat(64),
      storageLevel: undefined,
    })
    // 生成即复制：writeText 收到明文 key
    expect(clipboardWriteText).toHaveBeenCalledWith('plain-key-123')
    const env = wrapper.find('[data-test="connect-env"]')
    // 打码态：占位圆点在，明文不在 DOM
    expect(env.text()).toContain('UNSELF_MODULE_KEY=••••••••')
    expect(wrapper.text()).not.toContain('plain-key-123')
    // 请求体里没有明文
    expect(JSON.stringify(vi.mocked(registerConnectModule).mock.calls[0]![0])).not.toContain('plain-key-123')
    // 独立复制按钮已删
    expect(wrapper.find('[data-test="connect-copy"]').exists()).toBe(false)
  })

  it('点展示框=复制明文：再次 writeText，反馈「已复制」，2 秒后消退', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountDialog()
      await generateKey(wrapper)
      clipboardWriteText.mockClear()

      await wrapper.find('[data-test="connect-env"]').trigger('click')
      await flushPromises()

      expect(clipboardWriteText).toHaveBeenCalledTimes(1)
      expect(clipboardWriteText).toHaveBeenCalledWith('plain-key-123')
      expect(wrapper.find('[data-test="connect-copy-feedback"]').text()).toBe('已复制')
      vi.advanceTimersByTime(2100)
      await flushPromises()
      expect(wrapper.find('[data-test="connect-copy-feedback"]').text()).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clipboard 失败（生成时与点框时）：降级为亮出并选中明文，提示手动 Ctrl+C', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWriteText.mockRejectedValue(new Error('NotAllowedError')) },
      configurable: true,
    })
    const selectAllChildren = vi.spyOn(Selection.prototype, 'selectAllChildren').mockImplementation(() => {})
    try {
      const wrapper = mountDialog()
      await generateKey(wrapper)
      // 生成即复制的失败已进降级态
      expect(wrapper.find('[data-test="connect-copy-feedback"]').text()).toContain('Ctrl+C')

      await wrapper.find('[data-test="connect-env"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-test="connect-copy-feedback"]').text()).toContain('Ctrl+C')
      expect(wrapper.find('[data-test="connect-env"]').text()).toContain('plain-key-123')
      expect(selectAllChildren).toHaveBeenCalled()
    } finally {
      selectAllChildren.mockRestore()
      clipboardWriteText.mockResolvedValue(undefined)
    }
  })

  it('眼睛内嵌在展示框右侧：切换后明文出现/消失，独立「显示」按钮不存在', async () => {
    const wrapper = mountDialog()
    await generateKey(wrapper)

    const eye = wrapper.find('[data-test="connect-toggle-key"]')
    // 内嵌小眼睛：无文字，靠 aria-label 说明（不是带「显示/隐藏」文案的大按钮）
    expect(eye.text()).toBe('')
    expect(eye.attributes('aria-label')).toBe('显示接入码')
    expect(wrapper.find('[data-test="connect-env"]').text()).toContain('••••••••')

    await eye.trigger('click')
    expect(eye.attributes('aria-label')).toBe('隐藏接入码')
    expect(wrapper.find('[data-test="connect-env"]').text()).toContain('UNSELF_MODULE_KEY=plain-key-123')
    expect(wrapper.text()).toContain('plain-key-123')

    await eye.trigger('click')
    expect(wrapper.find('[data-test="connect-env"]').text()).toContain('••••••••')
    expect(wrapper.find('[data-test="connect-env"]').text()).not.toContain('plain-key-123')
  })

  it('UNSELF_CORE_URL 说明挂在生成按钮 hover/focus 的 tooltip 上，正文不再有长说明段', async () => {
    const wrapper = mountDialog()

    const help = wrapper.find('[data-test="connect-generate"]')
    expect(help.attributes('aria-describedby')).toBe('core-url-tip')
    const tipHidden = (): boolean => wrapper.find('[data-test="connect-env-help-tip"]').attributes('style')?.includes('display: none') ?? false
    // 默认隐藏（v-show）
    expect(tipHidden()).toBe(true)
    await help.trigger('mouseenter')
    expect(tipHidden()).toBe(false)
    expect(wrapper.find('[data-test="connect-env-help-tip"]').text()).toContain('UNSELF_CORE_URL')
    await help.trigger('mouseleave')
    expect(tipHidden()).toBe(true)
    // focus 也能唤出（键盘可达）
    await help.trigger('focus')
    expect(tipHidden()).toBe(false)
    await help.trigger('blur')
    expect(tipHidden()).toBe(true)
    // 正文旧长说明段已删
    expect(wrapper.text()).not.toContain('只显示这一次')
    expect(wrapper.text()).not.toContain('以模块所在机器能连到为准')
  })

  it('CF 凭证说明段已删（只用于本次部署的段落不再出现）', async () => {
    const wrapper = mountDialog()
    await wrapper.find('[data-test="add-module-tab-cloudflare"]').trigger('click')
    expect(wrapper.text()).not.toContain('凭证只用于本次部署')
  })

  it('模块 id 不合法：直接人话报错，不打接口', async () => {
    const wrapper = mountDialog()
    await wrapper.find('[data-test="connect-id"]').setValue('Bridge_1')
    await wrapper.find('[data-test="connect-generate"]').trigger('click')
    await flushPromises()

    expect(registerConnectModule).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="add-module-alert"]').text()).toContain('小写字母')
  })

  it('生成前查已有模块：id 重名就人话拦下，不生成也不注册', async () => {
    vi.mocked(fetchAdminModules).mockResolvedValue([mod({ id: 'bridge' })])
    const wrapper = mountDialog()
    await wrapper.find('[data-test="connect-id"]').setValue('bridge')
    await wrapper.find('[data-test="connect-generate"]').trigger('click')
    await flushPromises()

    expect(fetchAdminModules).toHaveBeenCalled()
    expect(generateConnectKey).not.toHaveBeenCalled()
    expect(registerConnectModule).not.toHaveBeenCalled()
    const alert = wrapper.find('[data-test="add-module-alert"]').text()
    expect(alert).toContain('已经有了')
    expect(alert).toContain('bridge')
  })

  it('服务端回 409：界面说人话（这个 id 已经有了），不把状态码抛给用户', async () => {
    vi.mocked(registerConnectModule).mockRejectedValue(makeApiError(409, '请求失败（409）'))
    const wrapper = mountDialog()
    await wrapper.find('[data-test="connect-id"]').setValue('bridge')
    await wrapper.find('[data-test="connect-generate"]').trigger('click')
    await flushPromises()

    const alert = wrapper.find('[data-test="add-module-alert"]').text()
    expect(alert).toContain('已经有了')
    expect(alert).not.toContain('409')
    expect(wrapper.find('[data-test="connect-env"]').exists()).toBe(false)
  })

  it('测试变绿后改模块 id：测试结果作废，保存重新禁用，须对新 id 重测', async () => {
    const wrapper = mountDialog()
    await generateKey(wrapper)
    await wrapper.find('[data-test="connect-test"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="connect-save"]').attributes('disabled')).toBeUndefined()

    await wrapper.find('[data-test="connect-id"]').setValue('bridge2')
    await flushPromises()

    // 回 idle：绿字消失、水位回落、保存不可用
    expect(wrapper.find('[data-test="add-module-status"]').exists()).toBe(false)
    expect(wrapper.find('[data-level]').attributes('data-level')).toBe('rest')
    expect(wrapper.find('[data-test="connect-save"]').attributes('disabled')).toBeDefined()

    // 对当前 id 重测才恢复可保存
    vi.mocked(fetchConnectStatus).mockResolvedValue({ moduleId: 'bridge2', online: true })
    await wrapper.find('[data-test="connect-test"]').trigger('click')
    await flushPromises()
    expect(fetchConnectStatus).toHaveBeenLastCalledWith('bridge2')
    expect(wrapper.find('[data-test="connect-save"]').attributes('disabled')).toBeUndefined()
  })

  it('测试变绿后改存储落点：同样作废测试结果，保存需重测', async () => {
    const wrapper = mountDialog()
    await generateKey(wrapper)
    await wrapper.find('[data-test="connect-test"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="connect-save"]').attributes('disabled')).toBeUndefined()

    wrapper.findAllComponents(UMotionSelect)[0]!.vm.$emit('update:modelValue', 'core')
    await flushPromises()

    expect(wrapper.find('[data-test="add-module-status"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="connect-save"]').attributes('disabled')).toBeDefined()
  })

  it('测试连接绿之前保存按钮不可用；绿了才能保存并通知页面刷新', async () => {
    const wrapper = mountDialog()
    await generateKey(wrapper)
    expect(wrapper.find('[data-test="connect-save"]').attributes('disabled')).toBeDefined()

    // 水位联动（#100 同规）：静息 → 在线满灌。
    // （testing「波动」帧只在真机网络往返可见；测试里 mock 同 tick resolve，DOM 只补最终态。）
    expect(wrapper.find('[data-level]').attributes('data-level')).toBe('rest')
    await wrapper.find('[data-test="connect-test"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="add-module-status"]').text()).toContain('隧道在线')
    expect(wrapper.find('[data-level]').attributes('data-level')).toBe('full')
    expect(wrapper.find('[data-test="connect-save"]').attributes('disabled')).toBeUndefined()

    await wrapper.find('[data-test="connect-save"]').trigger('click')
    await flushPromises()
    expect(activateConnectModule).toHaveBeenCalledWith('bridge')
    expect(wrapper.emitted('done')).toHaveLength(1)
  })

  it('模块没连上来：给可操作的人话，不伪造成功', async () => {
    vi.mocked(fetchConnectStatus).mockResolvedValue({ moduleId: 'bridge', online: false })
    const wrapper = mountDialog()
    await generateKey(wrapper)
    await wrapper.find('[data-test="connect-test"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="add-module-alert"]').text()).toContain('还没连上来')
    expect(wrapper.find('[data-level]').attributes('data-level')).toBe('rest')
    expect(wrapper.find('[data-test="connect-save"]').attributes('disabled')).toBeDefined()
  })

  it('CF 部署：token 是密码框；部署后组件状态里不再留着它', async () => {
    const wrapper = mountDialog()
    await wrapper.find('[data-test="add-module-tab-cloudflare"]').trigger('click')
    expect(wrapper.find('[data-test="cf-token"]').attributes('type')).toBe('password')

    await wrapper.find('[data-test="cf-npmspec"]').setValue('@unself/hello@0.1.0')
    await wrapper.find('[data-test="cf-account"]').setValue('acc-1')
    await wrapper.find('[data-test="cf-token"]').setValue('cf-plain-token')
    await wrapper.find('[data-test="cf-install"]').trigger('click')
    await flushPromises()

    expect(installCloudflareModule).toHaveBeenCalledWith({
      npmSpec: '@unself/hello@0.1.0',
      cfToken: 'cf-plain-token',
      accountId: 'acc-1',
      storageLevel: undefined,
    })
    expect((wrapper.find('[data-test="cf-token"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.emitted('done')).toHaveLength(1)
  })
})

describe('ModulesPage 入口（#349）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchAdminModules).mockResolvedValue([mod()])
    vi.mocked(toggleModule).mockResolvedValue({})
    vi.mocked(generateConnectKey).mockResolvedValue({ key: 'k', keyHash: 'f'.repeat(64) })
    vi.mocked(registerConnectModule).mockResolvedValue({ id: 'bridge', mode: 'connect', enabled: false })
  })

  it('右上角「新增模块」打开弹窗；成功后重取列表', async () => {
    const wrapper = mount(ModulesPage)
    await flushPromises()
    expect(wrapper.find('[data-test="add-module-dialog"]').exists()).toBe(false)

    await wrapper.find('[data-test="add-module"]').trigger('click')
    expect(wrapper.find('[data-test="add-module-dialog"]').exists()).toBe(true)

    await wrapper.findComponent(AddModuleDialog).vm.$emit('done')
    await flushPromises()
    // 首次挂载 + 完成后刷新
    expect(fetchAdminModules).toHaveBeenCalledTimes(2)
  })
})
