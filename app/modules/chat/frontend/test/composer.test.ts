// SPDX-License-Identifier: AGPL-3.0-only
import { flushPromises } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Composer from '../src/components/Composer.vue'
import { DRAFT_SAVE_DELAY_MS, loadDraft, resetDraftsForTest, saveDraft } from '../src/lib/draft'
import type { AnalyserLike, MediaRecorderLike } from '../src/lib/voice-recorder'
import type { UserSummary } from '../src/lib/types'

/**
 * Composer 行为（#218 C 路）：send 事件、@选择器键盘交互、composition 防误发、
 * 文件选择→本地预览→确认发送、草稿随 contextKey 切换、回复条、语音录制→send-voice。
 * 两问检验：改坏发送守卫/提及插入/草稿键/录制清理 → 红；重构模板实现不变 → 绿。
 */

/** Node 26 + jsdom 27 下全局无 localStorage（Node 的 getter 未开 --localstorage-file）。 */
function stubLocalStorage(): void {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => void store.set(key, value),
      removeItem: (key: string): void => void store.delete(key),
      clear: (): void => store.clear(),
      key: (index: number): string | null => [...store.keys()][index] ?? null,
      get length(): number {
        return store.size
      },
    },
    configurable: true,
  })
}

stubLocalStorage()

const contacts: UserSummary[] = [
  { id: 11, username: 'alice', displayName: 'Alice', avatarUrl: '' },
  { id: 12, username: 'bob', displayName: 'Bob', avatarUrl: '' },
  { id: 13, username: 'carol', displayName: 'Carol', avatarUrl: '' },
]

function inputOf(wrapper: ReturnType<typeof mountComposer>) {
  return wrapper.find('[data-test="composer-input"]')
}

function mountComposer(props: Record<string, unknown> = {}) {
  return mount(Composer, {
    props: { contextKey: 'channel.1', contacts, ...props },
  })
}

beforeEach(() => {
  // jsdom 无 localStorage 实装（安全属性缺失）——纸面清空即可：本套件草稿经 resetDraftsForTest 归零
  window.localStorage?.clear?.()
  resetDraftsForTest()
})

describe('Composer 发送', () => {
  it('打开 emoji 选择器并把 Unicode emoji 插入光标位置', async () => {
    const wrapper = mountComposer()
    const input = inputOf(wrapper)

    await input.setValue('你好')
    ;(input.element as HTMLTextAreaElement).setSelectionRange(2, 2)
    await wrapper.get('[data-test="emoji-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="emoji-picker"]').exists()).toBe(true)
    await wrapper.get('[data-test="emoji-picker"] button').trigger('click')

    expect((input.element as HTMLTextAreaElement).value).toBe('你好😀')
    expect(wrapper.find('[data-test="emoji-picker"]').exists()).toBe(false)
  })

  it('空文本禁用发送；输入后点击发送 emit send(文本, mentionUserIds) 且清空输入', async () => {
    const wrapper = mountComposer()
    const send = wrapper.find('[data-test="send"]')
    expect((send.element as HTMLButtonElement).disabled).toBe(true)

    await inputOf(wrapper).setValue('你好 世界')
    expect((send.element as HTMLButtonElement).disabled).toBe(false)
    await send.trigger('click')

    const emitted = wrapper.emitted('send')
    expect(emitted).toEqual([['你好 世界', []]])
    expect((inputOf(wrapper).element as HTMLTextAreaElement).value).toBe('')
  })

  it('Enter 发送、Shift+Enter 换行（不发送）', async () => {
    const wrapper = mountComposer()
    await inputOf(wrapper).setValue('第一行')
    await inputOf(wrapper).trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toHaveLength(1)

    await inputOf(wrapper).setValue('第二行')
    await inputOf(wrapper).trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toHaveLength(1)
  })

  it('sending/disabled 状态下 Enter 不发送', async () => {
    const wrapper = mountComposer({ sending: true })
    await inputOf(wrapper).setValue('内容')
    await inputOf(wrapper).trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
  })
})

describe('Composer @选择器', () => {
  it('@ 触发浮层，键盘 ↓/Enter 插入 @username，send 时带上 mentionUserIds', async () => {
    const wrapper = mountComposer()
    const input = inputOf(wrapper)

    await input.setValue('嗨 @')
    expect(wrapper.find('[data-test="mention-menu"]').exists()).toBe(true)

    await input.trigger('keydown', { key: 'ArrowDown' }) // alice→bob
    await input.trigger('keydown', { key: 'Enter' })

    expect((input.element as HTMLTextAreaElement).value).toBe('嗨 @bob ')
    expect(wrapper.find('[data-test="mention-menu"]').exists()).toBe(false)

    await input.setValue('嗨 @bob 顺便 @alice 看看')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([['嗨 @bob 顺便 @alice 看看', [11, 12]]])
  })

  it('@ 前缀过滤候选，点击候选项同样插入', async () => {
    const wrapper = mountComposer()
    const input = inputOf(wrapper)

    await input.setValue('@c')
    const options = wrapper.findAll('[data-test^="mention-option-"]')
    expect(options).toHaveLength(1)
    expect(options[0]?.attributes('data-test')).toBe('mention-option-carol')

    await options[0]!.trigger('mousedown')
    expect((input.element as HTMLTextAreaElement).value).toBe('@carol ')
  })

  it('Escape 关闭浮层后，Enter 照常发送文本（浮层不再拦截）', async () => {
    const wrapper = mountComposer()
    const input = inputOf(wrapper)
    await input.setValue('@')
    await input.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-test="mention-menu"]').exists()).toBe(false)
    await input.trigger('keydown', { key: 'Enter' })
    // @ 不是可发送正文（trim 后非空会发出），断言浮层关闭后 Enter 回归发送语义
    expect(wrapper.emitted('send')).toHaveLength(1)
    expect(wrapper.emitted('send')?.[0]?.[0]).toBe('@')
  })

  it('删除 @username 后 mentionUserIds 同步移除', async () => {
    const wrapper = mountComposer()
    const input = inputOf(wrapper)
    await input.setValue('@bob 在吗')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[0]?.[1]).toEqual([12])

    await input.setValue('在吗')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[1]?.[1]).toEqual([])
  })
})

describe('Composer 中文输入法', () => {
  it('composition 期间 Enter 不发送，结束后恢复', async () => {
    const wrapper = mountComposer()
    const input = inputOf(wrapper)

    await input.setValue('nihao')
    await input.trigger('compositionstart')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()

    await input.trigger('compositionend')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toHaveLength(1)
  })
})

describe('Composer 文件', () => {
  async function choose(wrapper: ReturnType<typeof mountComposer>, file: File) {
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
  }

  it('选择仅本地预览；移除、替换和卸载释放图片，不调用发送', async () => {
    const createUrl = vi.fn(() => 'blob:preview')
    const revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true })
    const submitFile = vi.fn()
    const wrapper = mountComposer({ submitFile })
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    await choose(wrapper, file)
    expect(wrapper.get('[data-test="pending-file"] img').attributes('src')).toBe('blob:preview')
    expect(wrapper.get('[data-test="pending-file"]').text()).toContain('待发送')
    expect(submitFile).not.toHaveBeenCalled()
    expect(wrapper.emitted('send-file')).toBeUndefined()
    await choose(wrapper, new File(['other'], 'other.png', { type: 'image/png' }))
    expect(revoke).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-test="clear-file"]').trigger('click')
    expect(wrapper.find('[data-test="pending-file"]').exists()).toBe(false)
    expect(revoke).toHaveBeenCalledTimes(2)
    await choose(wrapper, file)
    wrapper.unmount()
    expect(revoke).toHaveBeenCalledTimes(3)
    expect(submitFile).not.toHaveBeenCalled()
  })

  it('点击发送才提交文件与说明，忙碌时防重复；失败保留并允许 Enter 重试', async () => {
    let reject!: (error: Error) => void
    const submitFile = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
      .mockResolvedValueOnce(undefined)
    const wrapper = mountComposer({ submitFile })
    const file = new File(['hello'], 'report.pdf', { type: 'application/pdf' })
    await choose(wrapper, file)
    await inputOf(wrapper).setValue('这是报告 @alice ')
    await inputOf(wrapper).trigger('keydown', { key: 'Escape' })
    await wrapper.get('[data-test="send"]').trigger('click')
    expect(submitFile).toHaveBeenCalledWith(file, '这是报告 @alice', [11], expect.any(AbortSignal))
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.get('[data-test="send"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-test="clear-file"]').attributes('disabled')).toBeDefined()
    await inputOf(wrapper).trigger('keydown', { key: 'Enter' })
    expect(submitFile).toHaveBeenCalledTimes(1)
    reject(new Error('网络不可用'))
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('网络不可用')
    expect((inputOf(wrapper).element as HTMLTextAreaElement).value).toBe('这是报告 @alice ')
    await inputOf(wrapper).trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(submitFile).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-test="pending-file"]').exists()).toBe(false)
    expect((inputOf(wrapper).element as HTMLTextAreaElement).value).toBe('')
    wrapper.unmount()
  })

  it('只选文件也显示发送按钮；切换会话后旧提交完成不会清除新草稿', async () => {
    let complete!: () => void
    const submitFile = vi.fn(() => new Promise<void>((resolve) => { complete = resolve }))
    const wrapper = mountComposer({ submitFile })
    const file = new File(['x'], 'a.bin')
    await choose(wrapper, file)
    expect(wrapper.get('[data-test="send"]').isVisible()).toBe(true)
    await wrapper.get('[data-test="send"]').trigger('click')
    vi.useFakeTimers()
    saveDraft('channel', 2, '新会话草稿')
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS + 1)
    vi.useRealTimers()
    await wrapper.setProps({ contextKey: 'channel.2' })
    expect(wrapper.find('[data-test="pending-file"]').exists()).toBe(false)
    complete()
    await flushPromises()
    expect((inputOf(wrapper).element as HTMLTextAreaElement).value).toBe('新会话草稿')
    wrapper.unmount()
  })
})

describe('Composer 草稿', () => {
  it('输入经 debounce 落 localStorage，切 contextKey 恢复对应草稿', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountComposer({ contextKey: 'channel.7' })
      await inputOf(wrapper).setValue('未发送的草稿')
      await vi.advanceTimersByTimeAsync(300)
      expect(loadDraft('channel', 7)).toBe('未发送的草稿')

      await wrapper.setProps({ contextKey: 'channel.9' })
      expect((inputOf(wrapper).element as HTMLTextAreaElement).value).toBe('')

      await wrapper.setProps({ contextKey: 'channel.7' })
      expect((inputOf(wrapper).element as HTMLTextAreaElement).value).toBe('未发送的草稿')
    } finally {
      vi.useRealTimers()
    }
  })

  it('发送后草稿清除（重新进房不回填旧文本）', async () => {
    // jsdom 无真 localStorage 属性（安全 getter 抛 SecurityError）→ 直接经存储抽象写入
    vi.useFakeTimers()
    try {
      saveDraft('channel', 5, '旧草稿')
      await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DELAY_MS)
      const wrapper = mountComposer({ contextKey: 'channel.5' })
      expect((inputOf(wrapper).element as HTMLTextAreaElement).value).toBe('旧草稿')

      await inputOf(wrapper).trigger('keydown', { key: 'Enter' })
      expect(wrapper.emitted('send')).toHaveLength(1)
      expect(loadDraft('channel', 5)).toBe('')

      await wrapper.setProps({ contextKey: 'channel.6' })
      await wrapper.setProps({ contextKey: 'channel.5' })
      expect((inputOf(wrapper).element as HTMLTextAreaElement).value).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Composer 回复条', () => {
  it('replyTo 显示摘要，X 取消 emit cancel-reply', async () => {
    const wrapper = mountComposer({
      replyTo: {
        id: 99,
        content: '这是一条特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别特别长的消息',
        mentionUserIds: [],
        mentions: [],
        createdAt: '2026-09-16T00:00:00Z',
        source: 'local',
        sender: { kind: 'local', id: 1, username: 'u', displayName: '小明', avatarUrl: '', source: 'local' },
        attachment: null,
      },
    })
    expect(wrapper.find('[data-test="reply-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="reply-preview"]').text()).toContain('…')

    await wrapper.find('[data-test="cancel-reply"]').trigger('click')
    expect(wrapper.emitted('cancel-reply')).toHaveLength(1)
  })
})

// ---------- 语音录制（外部能力 stub 为 fake） ----------

class FakeMediaRecorder implements MediaRecorderLike {
  static instances: FakeMediaRecorder[] = []

  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  constructor(public stream: unknown) {
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {}

  stop(): void {
    this.ondataavailable?.({ data: new Blob(['voice'], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

function fakeAnalyser(analyserFrames: number[][]): AnalyserLike {
  let call = 0
  return {
    fftSize: 8,
    getByteTimeDomainData(array: Uint8Array): void {
      const frame = analyserFrames[Math.min(call, analyserFrames.length - 1)] ?? [128]
      call += 1
      for (let i = 0; i < array.length; i++) array[i] = frame[i % frame.length] ?? 128
    },
  }
}

function stubVoiceEnv(): void {
  const track = { stop: vi.fn() }
  const stream = { getTracks: () => [track] }
  const getUserMedia = vi.fn(async () => stream)
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...(globalThis.navigator ?? {}), mediaDevices: { getUserMedia } },
    configurable: true,
    writable: true,
  })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  const analyser = fakeAnalyser([[178, 178, 178, 178, 178, 178, 178, 178]])
  const FakeAudioContext = class {
    createMediaStreamSource() {
      return { connect: (): void => {} }
    }
    createAnalyser(): AnalyserLike {
      return analyser
    }
    close(): Promise<void> {
      return Promise.resolve()
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
}

describe('Composer 语音录制', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    Object.defineProperty(globalThis, 'navigator', {
      value: { ...(globalThis.navigator ?? {}), mediaDevices: undefined },
      configurable: true,
      writable: true,
    })
  })

  it('录音中显示计时器，停止→emit send-voice({file,durationMs,waveform 42 桶})', async () => {
    vi.useFakeTimers()
    stubVoiceEnv()
    const wrapper = mountComposer()

    const startBtn = wrapper.find('[data-test="record-start"]')
    expect((startBtn.element as HTMLButtonElement).disabled).toBe(false)
    await startBtn.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="recording-bar"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(wrapper.find('[data-test="recording-time"]').text()).toMatch(/^\d+:\d{2}$/)

    await vi.advanceTimersByTimeAsync(6_000) // 采样 ≥ 61 个 → 降采样到 42 桶
    await wrapper.find('[data-test="record-stop"]').trigger('click')
    await flushPromises()

    const emitted = wrapper.emitted('send-voice')
    expect(emitted).toHaveLength(1)
    const recording = emitted?.[0]?.[0] as { file: File; durationMs: number; waveform: number[] }
    expect(recording.file.name).toMatch(/^voice-\d+\.webm$/)
    expect(recording.file.type).toBe('audio/webm')
    expect(recording.durationMs).toBeGreaterThanOrEqual(6_000)
    expect(recording.waveform).toHaveLength(42)
    // 录完组件不保留状态
    expect(wrapper.find('[data-test="recording-bar"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="record-start"]').exists()).toBe(true)
  })

  it('取消按钮停止录制且不 emit send-voice，tracks 释放', async () => {
    vi.useFakeTimers()
    stubVoiceEnv()
    const wrapper = mountComposer()

    await wrapper.find('[data-test="record-start"]').trigger('click')
    await flushPromises()

    await wrapper.find('[data-test="record-cancel"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('send-voice')).toBeUndefined()
    expect(wrapper.find('[data-test="recording-bar"]').exists()).toBe(false)
  })

  it('不支持环境（无 mediaDevices）麦克风按钮禁用且带 title 提示', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { ...(globalThis.navigator ?? {}), mediaDevices: undefined },
      configurable: true,
      writable: true,
    })
    const wrapper = mountComposer()
    const mic = wrapper.find('[data-test="record-start"]')
    expect((mic.element as HTMLButtonElement).disabled).toBe(true)
    expect(mic.attributes('title')).toBeTruthy()
  })

  it('contextKey 切换时录制复位（不再 emit，录制条消失）', async () => {
    vi.useFakeTimers()
    stubVoiceEnv()
    const wrapper = mountComposer()
    await wrapper.find('[data-test="record-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="recording-bar"]').exists()).toBe(true)

    await wrapper.setProps({ contextKey: 'channel.2' })
    expect(wrapper.find('[data-test="recording-bar"]').exists()).toBe(false)
    expect(wrapper.emitted('send-voice')).toBeUndefined()
  })
})
