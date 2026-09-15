// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import MessageBubble from '../src/components/MessageBubble.vue'
import VoiceBubble from '../src/components/VoiceBubble.vue'
import type { Message } from '../src/lib/types'

/**
 * 消息气泡行为（#218）：作者/时间/分侧、引用块、文件附件占位、语音转发。
 */

const baseMessage = (over: Partial<Message> = {}): Message => ({
  id: 11,
  content: '你好，世界',
  mentionUserIds: [],
  mentions: [],
  createdAt: '2026-09-16T09:07:00',
  source: 'local',
  sender: { kind: 'local', id: 2, username: 'bob', displayName: '鲍勃', avatarUrl: '', source: 'local' },
  attachment: null,
  ...over,
})

describe('MessageBubble（#218）', () => {
  it('正文 + 作者 + HH:mm 可见；mine 证据 = bubble-mine 锚点', () => {
    const wrapper = mount(MessageBubble, { props: { message: baseMessage(), mine: false } })
    expect(wrapper.text()).toContain('你好，世界')
    expect(wrapper.text()).toContain('鲍勃')
    expect(wrapper.text()).toContain('09:07')
    expect(wrapper.find('[data-test="bubble-theirs"]').exists()).toBe(true)

    const mine = mount(MessageBubble, { props: { message: baseMessage(), mine: true } })
    expect(mine.find('[data-test="bubble-mine"]').exists()).toBe(true)
    mine.unmount()
    wrapper.unmount()
  })

  it('无效时间不显示空 time 标签（时间区退化为空）', () => {
    const wrapper = mount(MessageBubble, {
      props: { message: baseMessage({ createdAt: 'garbage' }), mine: false },
    })
    expect(wrapper.find('time').exists()).toBe(false)
    wrapper.unmount()
  })

  it('引用块：有摘要显示摘要；deleted 显示「原消息已删除」', () => {
    const wrapper = mount(MessageBubble, {
      props: { message: baseMessage(), mine: false, replyPreview: '上一条的内容' },
    })
    expect(wrapper.text()).toContain('上一条的内容')
    wrapper.unmount()

    const deleted = mount(MessageBubble, {
      props: { message: baseMessage(), mine: false, replyDeleted: true },
    })
    expect(deleted.text()).toContain('原消息已删除')
    deleted.unmount()
  })

  it('文件附件：显示文件名与 KB 大小占位', () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: baseMessage({
          attachment: { key: 'k', name: '报告.pdf', type: 'application/pdf', size: 2048, url: '/f/1' },
        }),
        mine: false,
      },
    })
    const file = wrapper.find('[data-test="bubble-file"]')
    expect(file.exists()).toBe(true)
    expect(file.text()).toContain('报告.pdf')
    expect(file.text()).toContain('2 KB')
    wrapper.unmount()
  })

  it('语音附件：转发渲染 VoiceBubble（波形气泡在场）', () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: baseMessage({
          attachment: { key: 'k', name: 'voice.webm', type: 'audio/webm', size: 9000, url: '/v/1', kind: 'voice', durationMs: 65400 },
        }),
        mine: false,
      },
    })
    expect(wrapper.findComponent(VoiceBubble).exists()).toBe(true)
    expect(wrapper.find('[data-test="voice-bubble"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('VoiceBubble（#218）', () => {
  it('显示时长 m:ss；真实波形按采样渲染条数', () => {
    const wrapper = mount(VoiceBubble, {
      props: {
        attachment: {
          key: 'k',
          name: 'v',
          type: 'audio/webm',
          size: 1,
          url: '/v/1',
          kind: 'voice',
          durationMs: 65400,
          waveform: [10, 90, 30, 60],
        },
      },
    })
    expect(wrapper.text()).toContain('1:05')
    expect(wrapper.findAll('.voice-bar')).toHaveLength(4)
    wrapper.unmount()
  })

  it('无波形 → 退化等高占位条；点击气泡展开播放器（audio 出现），再点收起', async () => {
    const wrapper = mount(VoiceBubble, {
      props: {
        attachment: { key: 'k', name: 'v', type: 'audio/webm', size: 1, url: '/v/1', kind: 'voice', durationMs: 0 },
      },
    })
    expect(wrapper.find('[data-test="voice-audio"]').exists()).toBe(false)
    expect(wrapper.findAll('.voice-bar').length).toBeGreaterThan(0)

    await wrapper.find('button').trigger('click')
    expect(wrapper.find('[data-test="voice-audio"]').exists()).toBe(true)
    expect(wrapper.emitted('toggle')?.[0]).toEqual([true])

    await wrapper.find('button').trigger('click')
    expect(wrapper.find('[data-test="voice-audio"]').exists()).toBe(false)
    expect(wrapper.emitted('toggle')?.[1]).toEqual([false])
    wrapper.unmount()
  })
})
