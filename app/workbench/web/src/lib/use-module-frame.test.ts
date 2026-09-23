// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref, toRef, type Ref } from 'vue'

import type { RegistryModule } from './registry-api'
import { HANDSHAKE_TIMEOUT_MS, isDisabledFrameError, useModuleFrame } from './use-module-frame'

describe('isDisabledFrameError（#83 停用判定唯一真值 = token 接口 403）', () => {
  it('status 403 为停用（ApiError 形态）', () => {
    expect(isDisabledFrameError(Object.assign(new Error('此模块已停用'), { status: 403 }))).toBe(
      true,
    )
  })

  it('非 403 状态不算停用（401/404/成功等）', () => {
    expect(isDisabledFrameError(Object.assign(new Error('登录已过期'), { status: 401 }))).toBe(
      false,
    )
    expect(isDisabledFrameError(Object.assign(new Error('未找到'), { status: 404 }))).toBe(false)
  })

  it('禁字符串嗅探：message 含「停用」但无 403 状态不判停用', () => {
    expect(isDisabledFrameError(new Error('此模块已停用'))).toBe(false)
  })

  it('非对象/缺状态回退 false', () => {
    expect(isDisabledFrameError(null)).toBe(false)
    expect(isDisabledFrameError(undefined)).toBe(false)
    expect(isDisabledFrameError('此模块已停用')).toBe(false)
  })

  it('超时常量仍是 15s（模块加载异常规范「加载中麒麟 → 失败卡」的握手时限，真值 docs/PRODUCT_SPEC.md 模块加载异常规范）', () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBe(15_000)
  })
})

/**
 * #306 根因回归（状态机层）：
 * 首次挂载（宿主已经带着「已选中模块」上桌，即工作台点模块 / 落地即选中）时，
 * 进握手态与上超时定时器必须在同一步完成——旧实现把两者拆在两个 watch 里，
 * pre-flush 的定时器 watch 永远看不到 setup 期同步发生的 idle→handshaking，
 * 定时器从未上表 → ready 缺失时骨架永久滞留（probe304 现场）。
 * 本组断言用户可感知的状态结果（handshaking → failed），不判内部实现。
 */
describe('useModuleFrame 握手超时（#306）', () => {
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
  } as RegistryModule

  /** 以「已选中模块」姿态首次挂载宿主（复刻点模块/落地即选中的进入方式）。 */
  function mountHostWithModule(mod: RegistryModule) {
    let api: ReturnType<typeof useModuleFrame>
    const Host = defineComponent({
      props: { module: { type: Object, default: null } },
      setup(props) {
        api = useModuleFrame(toRef(props, 'module') as Ref<RegistryModule | null>)
        return () => h('div')
      },
    })
    const wrapper = mount(Host, { props: { module: mod } })
    return { wrapper, api: api! }
  }

  it('首次挂载即选中模块：ready 不来 → 15s 落 failed（而非永久 handshaking）', async () => {
    vi.useFakeTimers()
    try {
      const { wrapper, api } = mountHostWithModule(MODULE)
      await flushPromises()
      await nextTick()
      await flushPromises()
      expect(api.frameState.value).toBe('handshaking')

      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 1)
      expect(api.frameState.value).toBe('failed')
      expect(api.frameError.value?.message).toContain('模块加载超时')

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('超时失败卡带可报障请求编号（壳侧发放，非服务端响应头）', async () => {
    vi.useFakeTimers()
    try {
      const { wrapper, api } = mountHostWithModule(MODULE)
      await flushPromises()
      await nextTick()
      await flushPromises()

      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 1)
      const err = api.frameError.value as { requestId?: string }
      expect(typeof err.requestId).toBe('string')
      expect(err.requestId).not.toBe('')

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('切到工作台（module → null）停表：不残留上一轮定时器把 idle 误判超时', async () => {
    vi.useFakeTimers()
    try {
      let api: ReturnType<typeof useModuleFrame>
      const module = ref<RegistryModule | null>(MODULE)
      const Host = defineComponent({
        setup() {
          api = useModuleFrame(module)
          return () => h('div')
        },
      })
      const wrapper = mount(Host)
      await flushPromises()
      await nextTick()
      await flushPromises()
      expect(api!.frameState.value).toBe('handshaking')

      // 用户切回工作台（取消搬运）：iframe 卸载，不该再被判超时
      module.value = null
      await nextTick()
      await flushPromises()
      expect(api!.frameState.value).toBe('idle')

      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 1)
      expect(api!.frameState.value).toBe('idle')

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('入口配置无效（entry 缺失/坏值）：直接失败且带请求编号，不留在握手态干等', async () => {
    vi.useFakeTimers()
    try {
      const broken = {
        id: 'broken',
        enabled: true,
        version: '0.1.0',
        manifest: { id: 'broken', route: '/m/broken/', entry: '', runtimes: ['worker'], version: '0.1.0' },
      } as RegistryModule
      const { wrapper, api } = mountHostWithModule(broken)
      await flushPromises()
      await nextTick()
      await flushPromises()

      expect(api.frameState.value).toBe('failed')
      expect(api.frameError.value?.message).toContain('模块入口配置无效')
      expect((api.frameError.value as { requestId?: string }).requestId).toBeTruthy()

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
