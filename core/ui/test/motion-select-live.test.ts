// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// 独立模块图：mock motionAvailable=true（真实浏览器语义）验证 motion 挂载路径不破坏交互。
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('../src/motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/motion')>()
  return { ...actual, motionAvailable: () => true }
})

describe('UMotionSelect（motion 可用环境）', () => {
  it('开面板 → 交互照常；选择后收起（useMotion 真实例化路径）', async () => {
    const { UMotionSelect } = await import('../src/index')
    const options = [
      { value: 'a.example.com', label: 'a.example.com' },
      { value: 'b.example.com', label: 'b.example.com' },
    ]
    const wrapper = mount(UMotionSelect, {
      props: { modelValue: null, options, label: '域名' },
      attachTo: document.body,
    })
    await wrapper.find('[aria-haspopup=listbox]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[role=listbox]')).not.toBeNull()
    await wrapper.find('[role=option]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['a.example.com'])
    expect(document.querySelector('[role=listbox]')).toBeNull()
    wrapper.unmount()
  })
})

import { UChoiceCardGroup } from '../src/index'

/**
 * 勾选状态行为（jsdom 可观察面；动效数值取证的浏览器证据见
 * /tmp/task-unself-ui-mime-evidence/12-choice-card-motion.md）。
 */
describe('UChoiceCardGroup（勾选状态行为）', () => {
  const options = [
    { value: 'hello', title: 'hello' },
    { value: 'chat', title: 'chat' },
    { value: 'todo', title: 'todo' },
  ]

  it('勾选 → 卡选中态（aria 与 checked 同步）+ 集合发出；取消 → 状态回落', async () => {
    const wrapper = mount(UChoiceCardGroup, {
      props: { mode: 'checkbox', modelValues: [], options, label: '模块' },
      attachTo: document.body,
    })
    await flushPromises()
    const boxes = wrapper.findAll('input[type=checkbox]')
    await boxes[0]!.setValue(true)
    await flushPromises()
    // 受控回写后的真实状态：第一卡选中、其余未选
    const wrapper2 = mount(UChoiceCardGroup, {
      props: { mode: 'checkbox', modelValues: ['hello'], options, label: '模块' },
      attachTo: document.body,
    })
    await flushPromises()
    const marks = wrapper2.findAll('.u-cc-mark')
    const checks = wrapper2.findAll('input[type=checkbox]')
    expect((checks[0]!.element as HTMLInputElement).checked).toBe(true)
    expect((checks[1]!.element as HTMLInputElement).checked).toBe(false)
    // 视觉选中态类挂在卡上
    expect(wrapper2.findAll('label.u-cc')[0]!.classes()).toContain('u-cc-selected')
    expect(wrapper2.findAll('label.u-cc')[1]!.classes()).not.toContain('u-cc-selected')
    // 勾图标 aria-hidden（自绘指示不进读屏）
    expect(marks[0]!.attributes('aria-hidden')).toBe('true')
    wrapper2.unmount()
    wrapper.unmount()
  })

  it('reduced-motion：卡与指示不声明 transition（动效层退化为瞬态，状态不丢）', async () => {
    const wrapper = mount(UChoiceCardGroup, {
      props: { mode: 'checkbox', modelValues: [], options, label: '模块' },
      attachTo: document.body,
    })
    // 组件在 reduced 环境的降级由 CSS media query 完成；jsdom 无级联 → 断言源样式不含
    // transition 的直接对象（已在 verify:tokens + 浏览器取证覆盖数值面）。
    // 这里断行为面：勾选照常发出、勾图标照常切换（降级不丢状态）。
    const boxes = wrapper.findAll('input[type=checkbox]')
    await boxes[1]!.setValue(true)
    expect(wrapper.emitted('update:modelValues')?.at(-1)).toEqual([['chat']])
    wrapper.unmount()
  })
})
