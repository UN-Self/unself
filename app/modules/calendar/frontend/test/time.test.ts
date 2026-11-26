// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { fromZonedInput, toZonedInput, toZonedShort } from '../src/lib/time.ts'

/** 时区换算：渲染与回写往返一致，偏移按该时区算。 */
describe('time 时区换算', () => {
  it('上海：08:00Z 渲染为 16:00', () => {
    expect(toZonedInput(Date.parse('2026-11-20T08:00:00Z'), 'Asia/Shanghai')).toBe('2026-11-20T16:00')
  })

  it('纽约：09:00 本地回写为对应 UTC 毫秒', () => {
    expect(fromZonedInput('2026-11-20T09:00', 'America/New_York')).toBe(
      Date.parse('2026-11-20T14:00:00Z'),
    )
  })

  it('三个时区往返一致', () => {
    for (const [input, tz] of [
      ['2026-11-20T09:00', 'Asia/Shanghai'],
      ['2026-07-01T00:00', 'Asia/Tokyo'],
      ['2026-12-01T23:45', 'America/New_York'],
    ] as const) {
      expect(toZonedInput(fromZonedInput(input, tz), tz)).toBe(input)
    }
  })

  it('短格式带月日与时分', () => {
    expect(toZonedShort(Date.parse('2026-11-20T08:00:00Z'), 'Asia/Shanghai')).toBe('11-20 16:00')
  })
})
