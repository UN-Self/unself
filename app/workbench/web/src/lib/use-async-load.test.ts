// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

import { useAsyncLoad } from './use-async-load'

/** 挂载壳：组合式必须在组件 setup 内使用（onMounted 语义）。 */
function mountWith(fetcher: () => Promise<unknown>, immediate?: boolean) {
  let api: ReturnType<typeof useAsyncLoad>
  const Comp = defineComponent({
    setup() {
      api = useAsyncLoad(fetcher, immediate === undefined ? undefined : { immediate })
      return () => h('div')
    },
  })
  const wrapper = mount(Comp)
  return { wrapper, api: api! }
}

describe('useAsyncLoad（#142 三态组合式）', () => {
  it('成功路径：初始 loading → 数据就位 → ready，loadError 清空', async () => {
    const fetcher = vi.fn(async () => ['a'])
    const { wrapper, api } = mountWith(fetcher)
    expect(api.phase.value).toBe('loading')
    await flushPromises()

    expect(fetcher).toHaveBeenCalledTimes(1) // immediate 默认挂载即加载
    expect(api.phase.value).toBe('ready')
    expect(api.data.value).toEqual(['a'])
    expect(api.loadError.value).toBeNull()
    wrapper.unmount()
  })

  it('失败路径：error 态 + loadError 保留原始错误对象（ApiError 形状原样）', async () => {
    const boom = Object.assign(new Error('请求失败（500）'), { status: 500, requestId: 'r1', detail: 'd' })
    const fetcher = vi.fn(async () => {
      throw boom
    })
    const { wrapper, api } = mountWith(fetcher)
    await flushPromises()

    expect(api.phase.value).toBe('error')
    expect(api.loadError.value).toBe(boom)
    expect(api.data.value).toBeNull()
    wrapper.unmount()
  })

  it('load() 重试：失败后再次 load → 成功翻转 ready（失败卡重试语义）', async () => {
    let fail = true
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error('x')
      return 'ok'
    })
    const { wrapper, api } = mountWith(fetcher)
    await flushPromises()
    expect(api.phase.value).toBe('error')

    fail = false
    await api.load()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(api.phase.value).toBe('ready')
    expect(api.data.value).toBe('ok')
    expect(api.loadError.value).toBeNull()
    wrapper.unmount()
  })

  it('重试期间回到 loading；再失败回到 error 且更新 loadError', async () => {
    const first = new Error('第一次')
    const second = new Error('第二次')
    let n = 0
    const fetcher = vi.fn(async () => {
      n += 1
      throw n === 1 ? first : second
    })
    const { wrapper, api } = mountWith(fetcher)
    await flushPromises()
    expect(api.loadError.value).toBe(first)

    const p = api.load()
    expect(api.phase.value).toBe('loading')
    await p
    expect(api.phase.value).toBe('error')
    expect(api.loadError.value).toBe(second)
    wrapper.unmount()
  })

  it('immediate=false：不自动加载，首次 load 驱动三态（空数据也按 ready）', async () => {
    const fetcher = vi.fn(async () => [] as string[])
    const { wrapper, api } = mountWith(fetcher, false)
    await flushPromises()
    expect(fetcher).not.toHaveBeenCalled()
    expect(api.phase.value).toBe('loading')

    await api.load()
    expect(api.phase.value).toBe('ready')
    expect(api.data.value).toEqual([])
    wrapper.unmount()
  })

  it('模板消费形状：phase/loadError 直接绑定（与 admin 页既有模板变量同名）', async () => {
    const fetcher = vi.fn(async () => 42)
    const Comp = defineComponent({
      setup() {
        const { phase, loadError, data, load } = useAsyncLoad(fetcher)
        return () => h('div', [
          h('span', phase.value),
          h('span', loadError.value === null ? 'no-err' : 'err'),
          h('span', String(data.value ?? '')),
          h('button', { onClick: () => void load() }, 'reload'),
        ])
      },
    })
    const wrapper = mount(Comp)
    await flushPromises()
    expect(wrapper.text()).toContain('ready')
    expect(wrapper.text()).toContain('42')
    wrapper.unmount()
  })
})
