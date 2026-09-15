// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { formatDayLabel, formatMessageTime, isSameDay } from '../src/lib/message-time'

/**
 * 消息时间显示行为（#218）：docs/testing.md 两问检验——
 * 改坏判定（如 isSameDay 恒 true）→ 当天/昨天/更早全部挤成一种显示，测试红；
 * 重构实现（换 padStart 写法）→ 输出不变，测试绿。
 */

const NOW = new Date('2026-09-16T10:30:00')

describe('isSameDay（#218）', () => {
  it('同一自然日 true，跨日/跨月/跨年 false', () => {
    expect(isSameDay(new Date('2026-09-16T00:00:01'), NOW)).toBe(true)
    expect(isSameDay(new Date('2026-09-16T23:59:59'), NOW)).toBe(true)
    expect(isSameDay(new Date('2026-09-15T23:59:59'), NOW)).toBe(false)
    expect(isSameDay(new Date('2026-09-17T00:00:00'), NOW)).toBe(false)
    expect(isSameDay(new Date('2025-09-16T10:30:00'), NOW)).toBe(false)
  })
})

describe('formatMessageTime（#218 气泡时间）', () => {
  it('当天只显示 HH:mm', () => {
    expect(formatMessageTime('2026-09-16T09:05:00', NOW)).toBe('09:05')
    expect(formatMessageTime('2026-09-16T23:05:00', NOW)).toBe('23:05')
  })

  it('昨天带「昨天」前缀', () => {
    expect(formatMessageTime('2026-09-15T08:00:00', NOW)).toBe('昨天 08:00')
  })

  it('更早显示 M月D日，跨年补年份', () => {
    expect(formatMessageTime('2026-01-03T12:00:00', NOW)).toBe('1月3日')
    expect(formatMessageTime('2025-12-31T23:59:00', NOW)).toBe('2025年12月31日')
  })

  it('无效时间显示为空串', () => {
    expect(formatMessageTime('not-a-date', NOW)).toBe('')
  })
})

describe('formatDayLabel（#218 日期分隔条）', () => {
  it('今天/昨天/更早/跨年', () => {
    expect(formatDayLabel('2026-09-16T01:00:00', NOW)).toBe('今天')
    expect(formatDayLabel('2026-09-15T01:00:00', NOW)).toBe('昨天')
    expect(formatDayLabel('2026-09-01T01:00:00', NOW)).toBe('9月1日')
    expect(formatDayLabel('2024-07-08T01:00:00', NOW)).toBe('2024年7月8日')
  })
})
