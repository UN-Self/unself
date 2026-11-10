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

/**
 * 「新增模块」双模式弹窗行为测试（#349 决策 #108/#109）。
 * 断言用户可见结果（面板切换、env 两行、按钮可用性、错误提示、保存后列表刷新），
 * 不碰组件内部字段名。密钥相关只断言「明文只出现在 env 区、请求只带哈希」。
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

describe('AddModuleDialog（#349 双模式）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(generateConnectKey).mockResolvedValue({ key: 'plain-key-123', keyHash: 'f'.repeat(64) })
    vi.mocked(registerConnectModule).mockResolvedValue({ id: 'bridge', mode: 'connect', enabled: false })
    vi.mocked(fetchConnectStatus).mockResolvedValue({ moduleId: 'bridge', online: true })
    vi.mocked(activateConnectModule).mockResolvedValue(mod({ id: 'bridge', mode: 'connect', entry: 'https://t/m/bridge/' }))
    vi.mocked(installCloudflareModule).mockResolvedValue(mod())
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
  })

  it('存储落点收敛（#349 验收）：反连只有 core/不指定，CF 保留四级', async () => {
    // 反连 tab：core 不部署模块运行体，shared/dedicated「核心代供」语义不成立
    const connect = mountDialog()
    const connectOptions = connect.findComponent(UMotionSelect).props('options') as Array<{ value: string }>
    expect(connectOptions.map((o) => o.value)).toEqual(['', 'core'])

    const cf = mountDialog()
    await cf.find('[data-test="add-module-tab-cloudflare"]').trigger('click')
    const cfOptions = cf.findComponent(UMotionSelect).props('options') as Array<{ value: string }>
    expect(cfOptions.map((o) => o.value)).toEqual(['', 'core', 'shared', 'dedicated', 'external'])
  })

  it('生成接入码：只把哈希交给 core，明文 key 只出现在 env 区一次', async () => {
    const wrapper = mountDialog()
    await wrapper.find('[data-test="connect-id"]').setValue('bridge')
    await wrapper.find('[data-test="connect-generate"]').trigger('click')
    await flushPromises()

    expect(registerConnectModule).toHaveBeenCalledWith({
      moduleId: 'bridge',
      keyHash: 'f'.repeat(64),
      storageLevel: undefined,
    })
    const env = wrapper.find('[data-test="connect-env"]').text()
    // env 收敛为 key 一项（#108 决策原样；id 不下发——core 凭哈希反查，地址按拓扑自填）
    expect(env).toContain('UNSELF_MODULE_KEY=plain-key-123')
    expect(env).not.toContain('UNSELF_MODULE_ID')
    expect(env).not.toContain('UNSELF_CORE_URL')
    // 生成的请求体里没有明文
    expect(JSON.stringify(vi.mocked(registerConnectModule).mock.calls[0]![0])).not.toContain('plain-key-123')
  })

  it('模块 id 不合法：直接人话报错，不打接口', async () => {
    const wrapper = mountDialog()
    await wrapper.find('[data-test="connect-id"]').setValue('Bridge_1')
    await wrapper.find('[data-test="connect-generate"]').trigger('click')
    await flushPromises()

    expect(registerConnectModule).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="add-module-alert"]').text()).toContain('小写字母')
  })

  it('测试连接绿之前保存按钮不可用；绿了才能保存并通知页面刷新', async () => {
    const wrapper = mountDialog()
    await wrapper.find('[data-test="connect-id"]').setValue('bridge')
    await wrapper.find('[data-test="connect-generate"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="connect-save"]').attributes('disabled')).toBeDefined()

    await wrapper.find('[data-test="connect-test"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="add-module-status"]').text()).toContain('隧道在线')
    expect(wrapper.find('[data-test="connect-save"]').attributes('disabled')).toBeUndefined()

    await wrapper.find('[data-test="connect-save"]').trigger('click')
    await flushPromises()
    expect(activateConnectModule).toHaveBeenCalledWith('bridge')
    expect(wrapper.emitted('done')).toHaveLength(1)
  })

  it('模块没连上来：给可操作的人话，不伪造成功', async () => {
    vi.mocked(fetchConnectStatus).mockResolvedValue({ moduleId: 'bridge', online: false })
    const wrapper = mountDialog()
    await wrapper.find('[data-test="connect-id"]').setValue('bridge')
    await wrapper.find('[data-test="connect-generate"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="connect-test"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="add-module-alert"]').text()).toContain('还没连上来')
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
