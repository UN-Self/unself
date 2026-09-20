// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { formatVoiceDuration, normalizeWaveform } from '../src/lib/waveform'

/**
 * 波形工具行为（#218 语音气泡）：降采样到固定桶数、0-100 归一、时长格式化。
 * 两问检验：改坏降采样算法（如恒返回空数组）→ 红；重构实现行为不变 → 绿。
 */
describe('normalizeWaveform', () => {
  it('超长采样降采样到目标桶数且每桶取窗口最大值', () => {
    const samples = [10, 90, 10, 10, 10, 10, 10, 10, 10, 70]
    const bars = normalizeWaveform(samples, 5)
    expect(bars).toEqual([90, 10, 10, 10, 70])
  })

  it('越界值夹到 0-100，空输入返回空数组', () => {
    expect(normalizeWaveform([-5, 250], 4)).toEqual([0, 100])
    expect(normalizeWaveform([], 42)).toEqual([])
  })

  it('时长格式化为 m:ss', () => {
    expect(formatVoiceDuration(0)).toBe('0:00')
    expect(formatVoiceDuration(65_400)).toBe('1:05')
    expect(formatVoiceDuration(-3)).toBe('0:00')
  })
})
