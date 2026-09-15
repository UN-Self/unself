// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 语音波形工具（#218）：MediaRecorder 采样 → 0-100 归一化数组；
 * 输出形状与上游 voice 附件 waveform 字段一致（数值语义参照，实现自写）。
 */

/** 任意采样序列归一化到固定长度（默认 42 桶，0-100 整数）。 */
export function normalizeWaveform(samples: number[], targetCount = 42): number[] {
  const values = Array.from(samples, (s) => clamp100(Math.round(Number(s) || 0)))
  if (!values.length) return []
  if (values.length <= targetCount) return values
  return Array.from({ length: targetCount }, (_, i) => {
    const start = Math.floor((i * values.length) / targetCount)
    const end = Math.max(start + 1, Math.floor(((i + 1) * values.length) / targetCount))
    let max = 0
    for (let j = start; j < end; j++) max = Math.max(max, values[j] ?? 0)
    return max
  })
}

/** 时长格式化 m:ss。 */
export function formatVoiceDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000) || 0)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}

function clamp100(n: number): number {
  return Math.min(100, Math.max(0, n))
}
