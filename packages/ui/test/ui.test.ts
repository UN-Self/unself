// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { mount } from '@vue/test-utils'

import { UButton, UCard, UErrorCard, UInput, USkeleton } from '../src/index'

/**
 * 基元测试（#60 测试标准执行 · 两问检验）：
 * 1. 故意改坏行为会红吗？
 * 2. 重构实现但行为不变，它要改吗？
 *
 * 断言分层：
 * - 用户交互行为（输入/点击/错误动画触发复位）= mount 真渲染后驱动事件，断状态与事件；
 * - 渲染输出契约（原生元素形态、label↔input 配对、表单默认语义、aria 状态）=
 *   SSR 输出即用户可见面（属性是行为载体：type="button" 防误提交、aria-busy 防连点）；
 * - 类名只在「基元对样式表的公开接口」位置断言（变体/尺寸/错误令牌），
 *   token 粒度不断言精确全串；CSS 级联后的视觉结果由主会话浏览器走查（docs/testing.md 职责边界）。
 */

describe('UInput 用户输入行为', () => {
  it('敲字 → 发出 update:modelValue（输入框的模型回写）', async () => {
    const wrapper = mount(UInput, { props: { modelValue: '', label: '关键词' } })
    await wrapper.find('input').setValue('unself')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['unself'])
  })
})

describe('UInput 错误抖动行为（beUI 语义：#60 死变量修复的正例）', () => {
  it('错误从无到有 → 抖动启动；animationend → 停止', async () => {
    const wrapper = mount(UInput)
    const input = wrapper.find('input')
    expect(input.classes()).not.toContain('u-input-shake')

    // 错误出现瞬间：抖动被触发（用户看到输入框晃动）
    await wrapper.setProps({ error: '不能为空' })
    expect(input.classes()).toContain('u-input-shake')

    // 动画自然结束（animationend）：抖动标记复位
    await input.element.dispatchEvent(new Event('animationend'))
    expect(input.classes()).not.toContain('u-input-shake')
  })

  it('错误清除立即复位；错误再次出现 → 重新抖动（动画可重放，不是一次性残留）', async () => {
    const wrapper = mount(UInput)
    const input = wrapper.find('input')

    await wrapper.setProps({ error: '第一条错误' })
    expect(input.classes()).toContain('u-input-shake')

    // 错误清除：即使动画未完也复位（下次错误必须能重新触发）
    await wrapper.setProps({ error: false })
    expect(input.classes()).not.toContain('u-input-shake')

    // 同一输入框第二次错误：再次抖动（防止「清不掉」的残留覆盖新错误）
    await wrapper.setProps({ error: '第二条错误' })
    expect(input.classes()).toContain('u-input-shake')
    await input.element.dispatchEvent(new Event('animationend'))
    expect(input.classes()).not.toContain('u-input-shake')
  })
})

describe('UErrorCard 详情/重试交互', () => {
  it('点「技术详情」→ 展开显示详情、aria-expanded=true；再点 → 收起', async () => {
    const wrapper = mount(UErrorCard, {
      props: { title: '同步失败', detail: 'stack trace', requestId: 'req-7a1' },
    })

    const toggle = wrapper.find('.u-error-toggle')
    const detailArea = () => wrapper.find('.u-error-detail')

    // 初始折叠：详情不可见（用户看不到堆栈）
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(detailArea().exists()).toBe(false)

    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(detailArea().text()).toContain('stack trace')

    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(detailArea().exists()).toBe(false)
  })

  it('点「重试」→ 发出 retry 事件（宿主据以重载）', async () => {
    const wrapper = mount(UErrorCard, {
      props: { title: '同步失败', retryLabel: '重新加载' },
    })
    await wrapper.find('.u-error-retry').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })
})

describe('UButton 加载与禁用（用户可见：不可交互 = 行为）', () => {
  it('loading → 按钮带 aria-busy 且 disabled（加载中不可再点）', async () => {
    const wrapper = mount(UButton, { props: { loading: true } })
    const btn = wrapper.find('button')
    expect(btn.attributes('aria-busy')).toBe('true')
    expect(btn.attributes('disabled')).toBeDefined()
  })

  it('disabled → 点击不产生 click（浏览器原生禁用语义）', async () => {
    const onClick = vi.fn()
    const wrapper = mount(UButton, { props: { disabled: true }, attrs: { onClick } })
    wrapper.find('button').element.click()
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('USkeleton / UCard 输出契约（props → 渲染结果）', () => {
  it('USkeleton：lines 决定行数；shortenLast=false 无末行缩短；加载语义 aria-busy', () => {
    const three = mount(USkeleton, { props: { lines: 3 } })
    expect(three.find('[role="status"]').attributes('aria-busy')).toBe('true')
    expect(three.findAll('.u-skeleton-line')).toHaveLength(3)
    expect(three.findAll('.u-skeleton-line-short')).toHaveLength(1)

    const noShort = mount(USkeleton, { props: { lines: 2, shortenLast: false } })
    expect(noShort.findAll('.u-skeleton-line')).toHaveLength(2)
    expect(noShort.findAll('.u-skeleton-line-short')).toHaveLength(0)
  })

  it('UCard：slot 内容呈现；padding 变体令牌随之切换', () => {
    const md = mount(UCard, { slots: { default: '卡片内容' } })
    expect(md.text()).toContain('卡片内容')
    expect(md.find('.u-card').classes()).toContain('u-card-md')

    const none = mount(UCard, { props: { padding: 'none' } })
    expect(none.find('.u-card').classes()).toContain('u-card-none')
  })
})

describe('SSR 渲染契约（渲染输出 = 用户可见面）', () => {
  it('UButton 默认：真实 button 元素 + type="button"（表单内不误触提交）+ slot 文案可见', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(UButton, null, () => '提交') }),
    )
    expect(html).toMatch(/<button[^>]*type="button"/)
    expect(html).toContain('提交')
  })

  it('UButton variant 变体令牌（样式契约：类名 = 基元对样式表的公开接口，视觉由走查覆盖）', async () => {
    const outline = await renderToString(
      createSSRApp({ render: () => h(UButton, { variant: 'outline' }, () => '边框') }),
    )
    // token 粒度：不断言精确 class 全串，容忍顺序/追加
    expect(outline).toContain('u-btn')
    expect(outline).toContain('u-btn-outline')
    expect(outline).toContain('u-btn-md')
  })

  it('UInput：label for 与 input id 配对（表单契约）；type/placeholder 透传；错误=aria-invalid + 文案', async () => {
    const ok = await renderToString(
      createSSRApp({ render: () => h(UInput, { label: '邮箱', type: 'email', placeholder: 'you@example.com' }) }),
    )
    const forMatch = /<label[^>]*\bfor="([^"]+)"/.exec(ok)
    expect(forMatch).not.toBeNull()
    expect(ok).toContain(`id="${forMatch![1]}"`)
    expect(ok).toContain('type="email"')
    expect(ok).toContain('placeholder="you@example.com"')

    const err = await renderToString(
      createSSRApp({ render: () => h(UInput, { label: '关键词', error: '不能为空' }) }),
    )
    expect(err).toContain('aria-invalid="true"')
    expect(err).toContain('不能为空')
  })

  it('UErrorCard：title 与「请求编号：<requestId>」可见（用户看得到的人话 + 追踪码）', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(UErrorCard, { title: '同步失败', requestId: 'req-7a1' }) }),
    )
    expect(html).toContain('同步失败')
    expect(html).toContain('请求编号：req-7a1')
  })
})
