// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
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
})
