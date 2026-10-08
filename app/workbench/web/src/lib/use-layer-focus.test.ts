// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useLayerFocus } from './use-layer-focus'

describe('弹层焦点恢复', () => {
  it('触发按钮随动作单消失后，关闭弹层聚焦指定的常驻按钮', async () => {
    const Harness = defineComponent({
      setup() {
        const open = ref(false)
        const menuOpen = ref(true)
        const dialog = ref<HTMLElement | null>(null)
        const stableButton = ref<HTMLElement | null>(null)
        useLayerFocus(open, () => dialog.value, () => stableButton.value)
        return () => h('div', [
          h('button', { ref: stableButton, id: 'stable' }, '我的'),
          menuOpen.value ? h('button', {
            id: 'temporary',
            onClick: () => { menuOpen.value = false; open.value = true },
          }, '修改昵称') : null,
          open.value ? h('section', { ref: dialog }, [
            h('button', { id: 'close', onClick: () => { open.value = false } }, '关闭'),
          ]) : null,
        ])
      },
    })
    const wrapper = mount(Harness, { attachTo: document.body })
    ;(wrapper.find('#temporary').element as HTMLElement).focus()
    await wrapper.find('#temporary').trigger('click')
    await nextTick()
    expect(wrapper.find('#temporary').exists()).toBe(false)
    await wrapper.find('#close').trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(wrapper.find('#stable').element)
    wrapper.unmount()
  })
})
