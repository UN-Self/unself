// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import { UActivity, UChoiceCardGroup, UMotionSelect } from '../src/index'

/**
 * 新基元行为测试（两问检验：改坏行为必红 / 重构不改测试）：
 * 断用户交互与 aria 状态，不断言样式实现细节。
 */

describe('UMotionSelect（beUI Morph Select 移植）', () => {
  const options = [
    { value: 'a.example.com', label: 'a.example.com' },
    { value: 'b.example.com', label: 'b.example.com' },
  ]

  it('关闭态点触发器 → 面板展开（aria-expanded）、再点选项 → 发出选中并收起', async () => {
    const wrapper = mount(UMotionSelect, {
      props: { modelValue: null, options, label: '域名' },
    })
    const trigger = wrapper.find('[aria-haspopup=listbox]')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[role=listbox]').exists()).toBe(true)
    await wrapper.find('[role=option]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['a.example.com'])
    expect(wrapper.find('[role=listbox]').exists()).toBe(false)
  })

  it('触发器 ArrowDown 键开面板；面板内 Escape 关闭还焦点触发器', async () => {
    const wrapper = mount(UMotionSelect, {
      props: { modelValue: null, options, label: '域名' },
      attachTo: document.body,
    })
    await wrapper.find('[aria-haspopup=listbox]').trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.find('[role=listbox]').exists()).toBe(true)
    await wrapper.find('[role=listbox]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role=listbox]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('aria-controls 绑定唯一面板 id；多实例 id 互不相同；activedescendant 随焦点走', async () => {
    const first = mount(UMotionSelect, {
      props: { modelValue: null, options, label: '域名' },
      attachTo: document.body,
    })
    const second = mount(UMotionSelect, {
      props: { modelValue: null, options, label: '域名' },
      attachTo: document.body,
    })
    const t1 = first.find('[aria-haspopup=listbox]')
    const t2 = second.find('[aria-haspopup=listbox]')
    const controls1 = t1.attributes('aria-controls')
    const controls2 = t2.attributes('aria-controls')
    expect(controls1).toBeTruthy()
    expect(controls2).toBeTruthy()
    expect(controls1).not.toBe(controls2)
    await t1.trigger('click')
    // 面板 id 与 aria-controls 一致（直接查 DOM）
    expect(document.getElementById(controls1!)).not.toBeNull()
    expect(first.find('[role=listbox]').attributes('id')).toBe(controls1)
    // activedescendant：无选中开面板 → 第一项
    expect(t1.attributes('aria-activedescendant')).toContain(controls1!)
    first.unmount()
    second.unmount()
  })

  it('已选值开面板 → 焦点落在选中项（activeIndex 对位，非第一项）', async () => {
    const wrapper = mount(UMotionSelect, {
      props: { modelValue: 'b.example.com', options, label: '域名' },
      attachTo: document.body,
    })
    await wrapper.find('[aria-haspopup=listbox]').trigger('click')
    await flushPromises()
    const focused = document.activeElement
    const opts = wrapper.findAll('[role=option]')
    expect(focused).toBe(opts[1]!.element)
    wrapper.unmount()
  })

  it('面板内 ArrowDown/ArrowUp 循环移动焦点；Home/End 跳端', async () => {
    const wrapper = mount(UMotionSelect, {
      props: { modelValue: null, options, label: '域名' },
      attachTo: document.body,
    })
    await wrapper.find('[aria-haspopup=listbox]').trigger('click')
    await flushPromises()
    const opts = wrapper.findAll('[role=option]')
    expect(document.activeElement).toBe(opts[0]!.element) // 无选中 → 第一项
    await opts[0]!.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(opts[1]!.element)
    await opts[1]!.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(opts[0]!.element) // 循环
    await opts[0]!.trigger('keydown', { key: 'ArrowUp' })
    expect(document.activeElement).toBe(opts[1]!.element)
    await opts[1]!.trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(opts[0]!.element)
    await opts[0]!.trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(opts[1]!.element)
    wrapper.unmount()
  })

  it('面板内 Enter 选择当前聚焦项并收起；Esc 关闭还焦点触发器', async () => {
    const wrapper = mount(UMotionSelect, {
      props: { modelValue: null, options, label: '域名' },
      attachTo: document.body,
    })
    const trigger = wrapper.find('[aria-haspopup=listbox]')
    await trigger.trigger('click')
    await flushPromises()
    const opts = wrapper.findAll('[role=option]')
    await opts[1]!.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['b.example.com'])
    expect(wrapper.find('[role=listbox]').exists()).toBe(false)
    // Esc 路径
    await trigger.trigger('click')
    await flushPromises()
    await wrapper.find('[role=listbox]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role=listbox]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('已选值回显在触发器；选中项 aria-selected=true', async () => {
    const wrapper = mount(UMotionSelect, {
      props: { modelValue: 'b.example.com', options, label: '域名' },
    })
    expect(wrapper.find('[aria-haspopup=listbox]').text()).toContain('b.example.com')
    await wrapper.find('[aria-haspopup=listbox]').trigger('click')
    const selected = wrapper.findAll('[role=option]')
    expect(selected[0]!.attributes('aria-selected')).toBe('false')
    expect(selected[1]!.attributes('aria-selected')).toBe('true')
  })

  it('面板响应式生命周期（watch 驱动）：开→挂 DOM；关→卸载；再开→重建（非 onMounted 一次性）', async () => {
    const wrapper = mount(UMotionSelect, {
      props: { modelValue: null, options, label: '域名' },
      attachTo: document.body,
    })
    const trigger = wrapper.find('[aria-haspopup=listbox]')
    await trigger.trigger('click')
    await flushPromises()
    expect(document.querySelector('[role=listbox]')).not.toBeNull()
    await trigger.trigger('click')
    await flushPromises()
    expect(document.querySelector('[role=listbox]')).toBeNull()
    await trigger.trigger('click')
    await flushPromises()
    expect(document.querySelector('[role=listbox]')).not.toBeNull()
    wrapper.unmount()
  })

})

describe('UChoiceCardGroup（勾选卡）', () => {
  it('多选：点选发出累计集合，再点取消', async () => {
    const wrapper = mount(UChoiceCardGroup, {
      props: {
        mode: 'checkbox',
        label: '模块',
        modelValues: [],
        options: [
          { value: 'hello', title: 'hello' },
          { value: 'chat', title: 'chat' },
        ],
      },
    })
    const boxes = wrapper.findAll('input[type=checkbox]')
    await boxes[0]!.setValue(true)
    expect(wrapper.emitted('update:modelValues')?.at(-1)).toEqual([['hello']])
    // 带着上一次发出的值继续（受控组件真实用法：父组件回写 modelValues）
    await wrapper.setProps({ modelValues: ['hello'] })
    await boxes[1]!.setValue(true)
    expect(wrapper.emitted('update:modelValues')?.at(-1)).toEqual([['hello', 'chat']])
    await wrapper.setProps({ modelValues: ['hello', 'chat'] })
    await boxes[0]!.setValue(false)
    expect(wrapper.emitted('update:modelValues')?.at(-1)).toEqual([['chat']])
  })

  it('单选：组内选择互斥（radio name 相同 + 发出单值）', async () => {
    const wrapper = mount(UChoiceCardGroup, {
      props: {
        mode: 'radio',
        name: 'sto',
        label: '数据落点',
        modelValue: null,
        options: [
          { value: 'core', title: 'core' },
          { value: 'dedicated', title: 'dedicated' },
        ],
      },
    })
    const radios = wrapper.findAll('input[type=radio]')
    expect(radios[0]!.attributes('name')).toBe('sto')
    expect(radios[1]!.attributes('name')).toBe('sto')
    await radios[1]!.setValue(true)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['dedicated'])
  })
})

describe('UActivity（beUI Agent Activity 移植）', () => {
  it('默认折叠（无 open）；v-model:open 打开后组与行可见；失败组默认展开', async () => {
    const groups = [
      {
        step: 1,
        title: '步骤 1/9',
        state: 'complete' as const,
        lines: [{ i: 0, text: '建 D1 ✓' }],
      },
      {
        step: 2,
        title: '步骤 2/9',
        state: 'failed' as const,
        lines: [{ i: 1, text: '迁移失败：cf_api_10000' }],
      },
    ]
    const wrapper = mount(UActivity, {
      props: { groups, summary: '2 个步骤', open: false },
    })
    expect(wrapper.find('ol').attributes('aria-live')).toBe('polite')
    expect(wrapper.find('ol').isVisible()).toBe(false)
    await wrapper.setProps({ open: true })
    expect(wrapper.find('ol').isVisible()).toBe(true)
    expect(wrapper.text()).toContain('步骤 2/9')
    expect(wrapper.text()).toContain('迁移失败：cf_api_10000')
    // 失败组在 open 容器内默认展开（failed → details open）
    const failedGroup = wrapper.findAll('li')[1]!.find('details')
    expect(failedGroup.attributes('open')).toBeDefined()
  })
})

import { UStepper, UBanner, UResultCard, UStepProgress } from '../src/index'

describe('UStepper（步进器）', () => {
  const steps = [
    { id: 'auth', label: '凭证' },
    { id: 'domain', label: '域名' },
    { id: 'modules', label: '模块' },
  ]

  it('三态渲染：done/current/future；done 可点发 navigate，future 不可点', async () => {
    const wrapper = mount(UStepper, { props: { steps, current: 1 } })
    const items = wrapper.findAll('.u-stepper-item')
    expect(items[0]!.classes()).toContain('done')
    expect(items[1]!.classes()).toContain('current')
    expect(items[2]!.classes()).toContain('future')
    await items[0]!.trigger('click')
    expect(wrapper.emitted('navigate')?.at(-1)).toEqual(['auth'])
    // future 不可点
    await items[2]!.trigger('click')
    expect(wrapper.emitted('navigate')).toHaveLength(1)
  })

  it('done 项键盘 Enter 触发 navigate（role=button + tabindex）', async () => {
    const wrapper = mount(UStepper, { props: { steps, current: 2 }, attachTo: document.body })
    const done = wrapper.findAll('.u-stepper-item')[0]!
    expect(done.attributes('role')).toBe('button')
    expect(done.attributes('tabindex')).toBe('0')
    await done.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('navigate')?.at(-1)).toEqual(['auth'])
    wrapper.unmount()
  })
})

describe('UBanner（信息横幅）', () => {
  it('warning 默认描边 + 图标 aria-hidden；slot 文案可见', () => {
    const wrapper = mount(UBanner, { slots: { default: '多级子域需要 Total TLS' } })
    expect(wrapper.text()).toContain('多级子域需要 Total TLS')
    expect(wrapper.find('svg').attributes('aria-hidden')).toBe('true')
  })
})

describe('UResultCard（结果卡）', () => {
  it('label/link 渲染 + 默认 success；warning tone 切换（入口已注册卡）', () => {
    const ok = mount(UResultCard, { props: { label: '部署入口已就绪', link: 'https://x/setup?token=t' } })
    expect(ok.find('[data-test=result-link]').text()).toBe('https://x/setup?token=t')
    const warn = mount(UResultCard, { props: { label: '入口已注册，可先继续', link: 'https://x/setup', tone: 'warning' } })
    expect(warn.find('section').classes()).toContain('u-result-warning')
  })
})

describe('UStepProgress（N 步进度条）', () => {
  it('段状态类随数据切换（done/running/failed）', () => {
    const wrapper = mount(UStepProgress, {
      props: {
        segments: [
          { n: 1, label: '1 数据库', state: 'done' },
          { n: 2, label: '2 迁移', state: 'running' },
          { n: 3, label: '3 核心', state: 'failed' },
          { n: 4, label: '4 模块', state: '' },
        ],
      },
    })
    expect(wrapper.find('[data-seg="1"]').classes()).toContain('done')
    expect(wrapper.find('[data-seg="2"]').classes()).toContain('running')
    expect(wrapper.find('[data-seg="3"]').classes()).toContain('failed')
    expect(wrapper.find('[data-seg="4"]').classes()).not.toContain('done')
  })
})
