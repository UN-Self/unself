// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createVoiceRecorder } from '../src/lib/voice-recorder'
import type { AnalyserLike, MediaRecorderLike } from '../src/lib/voice-recorder'

/**
 * 语音录制器行为（#218 C 路）：外部能力全部注入 fake（getUserMedia/MediaRecorder/
 * AudioContext/时钟），只测编排行为与产出形状。
 * 两问检验：改坏波形桶数/时长计算/cancel 释放 → 红；重构实现行为不变 → 绿。
 */

/** 可编程 fake MediaRecorder：stop() 时回调 ondataavailable（带 chunk）与 onstop。 */
class FakeMediaRecorder implements MediaRecorderLike {
  static instances: FakeMediaRecorder[] = []

  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  paused = false
  stopCalled = 0

  constructor(public stream: unknown) {
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {}

  stop(): void {
    this.stopCalled += 1
    this.ondataavailable?.({ data: new Blob(['chunk'], { type: 'audio/webm' }) })
    this.onstop?.()
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }
}

/** fake 音轨：stop 是 vi.fn，验证释放。 */
function fakeStream() {
  const track = { stop: vi.fn() }
  const stream = { getTracks: () => [track] }
  return { track, stream }
}

/** fake Analyser：测试按次推进音量帧（时间域字节，128 为静音中线）。 */
function fakeAnalyser(frames: number[][]): AnalyserLike {
  let call = 0
  return {
    fftSize: 8,
    getByteTimeDomainData(array: Uint8Array): void {
      const frame = frames[Math.min(call, frames.length - 1)] ?? [128]
      call += 1
      for (let i = 0; i < array.length; i++) array[i] = frame[i % frame.length] ?? 128
    },
  }
}

/** fake AudioContext：连接链最小实现，analyser 由测试注入。 */
function fakeAudioContext(analyser: AnalyserLike) {
  return class {
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
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createVoiceRecorder', () => {
  it('start/stop 产出 webm File、注入时钟时长与 42 桶波形', async () => {
    vi.useFakeTimers()
    let clockMs = 1_000
    const analyser = fakeAnalyser([
      [128, 128, 128, 128, 128, 128, 128, 128],
      [178, 178, 178, 178, 178, 178, 178, 178],
      [228, 228, 228, 228, 228, 228, 228, 228],
    ])
    const { stream } = fakeStream()
    const getUserMedia = vi.fn(async () => stream)
    const recorder = createVoiceRecorder({
      getUserMedia,
      MediaRecorder: FakeMediaRecorder as unknown as new (stream: unknown) => MediaRecorderLike,
      AudioContext: fakeAudioContext(analyser) as unknown as new () => never,
      now: () => clockMs,
    })

    const startPromise = recorder.start()
    await vi.advanceTimersByTimeAsync(6_000) // 100ms 采样 × 60 → 触发降采样
    await startPromise
    clockMs = 7_500 // 录制时长 6.5s

    const result = await recorder.stop()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(result.file).toBeInstanceOf(File)
    expect(result.file.name).toMatch(/^voice-\d+\.webm$/)
    expect(result.file.type).toBe('audio/webm')
    expect(result.file.size).toBeGreaterThan(0)
    expect(result.durationMs).toBe(6_500)
    expect(result.waveform).toHaveLength(42)
    // 高音量帧(228→RMS 0.5→125 夹 100)必须出现；纯静音段不在波形里
    expect(Math.max(...result.waveform)).toBe(100)
  })

  it('cancel 停止录制并释放 tracks（不产出文件）', async () => {
    const { track, stream } = fakeStream()
    const recorder = createVoiceRecorder({
      getUserMedia: async () => stream,
      MediaRecorder: FakeMediaRecorder as unknown as new (stream: unknown) => MediaRecorderLike,
    })
    await recorder.start()
    expect(recorder.recording).toBe(true)

    recorder.cancel()
    expect(recorder.recording).toBe(false)
    expect(track.stop).toHaveBeenCalled()
    await expect(recorder.stop()).rejects.toThrow('VOICE_NOT_RECORDING')
  })

  it('pause/resume 期间不计入时长', async () => {
    let clockMs = 0
    const recorder = createVoiceRecorder({
      getUserMedia: async () => fakeStream().stream,
      MediaRecorder: FakeMediaRecorder as unknown as new (stream: unknown) => MediaRecorderLike,
      now: () => clockMs,
    })
    await recorder.start()
    clockMs = 1_000
    recorder.pause()
    clockMs = 5_000 // 暂停 4s
    recorder.resume()
    clockMs = 6_000 // 再录 1s
    const result = await recorder.stop()
    expect(result.durationMs).toBe(2_000)
  })

  it('不支持环境（无 getUserMedia/MediaRecorder）start() 抛 VOICE_UNSUPPORTED', async () => {
    const original = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
    try {
      const recorder = createVoiceRecorder()
      await expect(recorder.start()).rejects.toThrow('VOICE_UNSUPPORTED')
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true })
    }
  })
})
