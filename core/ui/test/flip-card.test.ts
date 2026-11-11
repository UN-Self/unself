// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import UFlipCard from '../src/flip-card.vue'

describe('UFlipCard 分页交互边界', () => {
  it.each([false, true])('初始 flipped=%s 时只有当前页参与交互，往返翻页保留输入', async (flipped) => {
    const wrapper = mount(UFlipCard, {
      props: { flipped },
      slots: {
        front: '<input aria-label="前页输入" />',
        back: '<input aria-label="后页输入" />',
        corner: '<button type="button">翻页</button>',
      },
    })
    try {
      const front = wrapper.get('input[aria-label="前页输入"]')
      const back = wrapper.get('input[aria-label="后页输入"]')
      const corner = wrapper.get('button')
      const expectCurrentPage = (backActive: boolean) => {
        expect(front.element.closest('[inert]') !== null).toBe(backActive)
        expect(front.element.closest('[aria-hidden="true"]') !== null).toBe(backActive)
        expect(back.element.closest('[inert]') !== null).toBe(!backActive)
        expect(back.element.closest('[aria-hidden="true"]') !== null).toBe(!backActive)
        expect(corner.element.closest('[inert]') !== null).toBe(backActive)
      }

      expectCurrentPage(flipped)
      await (flipped ? back : front).setValue('已编辑的内容')
      await wrapper.setProps({ flipped: !flipped })
      expectCurrentPage(!flipped)
      await wrapper.setProps({ flipped })
      expectCurrentPage(flipped)
      expect(((flipped ? back : front).element as HTMLInputElement).value).toBe('已编辑的内容')
    } finally {
      wrapper.unmount()
    }
  })

  describe('尺寸实测与清理', () => {
    /** 记录实例与回调的 ResizeObserver 替身，供断言重测与卸载清理。 */
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = []
      disconnectCalled = false
      constructor(public callback: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this)
      }
      observe() {}
      unobserve() {}
      disconnect() {
        this.disconnectCalled = true
      }
      fire() {
        this.callback([], this as unknown as ResizeObserver)
      }
    }

    const rectAt = (width: number, height: number) =>
      ({
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect

    beforeEach(() => {
      FakeResizeObserver.instances = []
      vi.stubGlobal('ResizeObserver', FakeResizeObserver)
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rectAt(320, 240))
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    const pageEl = (wrapper: ReturnType<typeof mount>) =>
      wrapper.get('.u-flip-pages').element as HTMLElement

    it('挂载后把实测页宽高写进折线尺寸变量', async () => {
      const wrapper = mount(UFlipCard, { slots: { front: '前', back: '后' } })
      try {
        await nextTick()
        expect(pageEl(wrapper).style.getPropertyValue('--unself-page-width')).toBe('320px')
        expect(pageEl(wrapper).style.getPropertyValue('--unself-page-height')).toBe('240px')
      } finally {
        wrapper.unmount()
      }
    })

    it('容器尺寸变化经 ResizeObserver 触发重测，折线跟着新尺寸算', async () => {
      const wrapper = mount(UFlipCard, { slots: { front: '前', back: '后' } })
      try {
        expect(FakeResizeObserver.instances).toHaveLength(1)
        vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(rectAt(640, 480))
        FakeResizeObserver.instances[0].fire()
        await nextTick()
        expect(pageEl(wrapper).style.getPropertyValue('--unself-page-width')).toBe('640px')
        expect(pageEl(wrapper).style.getPropertyValue('--unself-page-height')).toBe('480px')
      } finally {
        wrapper.unmount()
      }
    })

    it('卸载时断开 ResizeObserver，不留观察器泄漏', () => {
      const wrapper = mount(UFlipCard, { slots: { front: '前', back: '后' } })
      const observer = FakeResizeObserver.instances[0]
      expect(observer.disconnectCalled).toBe(false)
      wrapper.unmount()
      expect(observer.disconnectCalled).toBe(true)
    })

    it('无 ResizeObserver 的环境挂载/翻页/卸载不崩，首次实测仍生效、只是失去重测', async () => {
      vi.stubGlobal('ResizeObserver', undefined)
      const wrapper = mount(UFlipCard, { slots: { front: '前', back: '后' } })
      try {
        await wrapper.setProps({ flipped: true })
        expect(wrapper.classes()).toContain('u-flip-book-open')
        expect(pageEl(wrapper).style.getPropertyValue('--unself-page-width')).toBe('320px')
        expect(FakeResizeObserver.instances).toHaveLength(0)
      } finally {
        wrapper.unmount()
      }
    })

    it('量不到尺寸（0 宽高，如未布局）时不写入退化值', () => {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(rectAt(0, 0))
      const wrapper = mount(UFlipCard, { slots: { front: '前', back: '后' } })
      try {
        expect(pageEl(wrapper).style.getPropertyValue('--unself-page-width')).toBe('')
        expect(pageEl(wrapper).style.getPropertyValue('--unself-page-height')).toBe('')
      } finally {
        wrapper.unmount()
      }
    })
  })
})
