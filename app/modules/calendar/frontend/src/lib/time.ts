// SPDX-License-Identifier: AGPL-3.0-only

/** 按期次时区渲染与解析时间，避免落到浏览器本地时区。 */

type TimeParts = { year: string; month: string; day: string; hour: string; minute: string }

const partsOf = (ms: number, timeZone: string): TimeParts => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const out: TimeParts = { year: '1970', month: '01', day: '01', hour: '00', minute: '00' }
  for (const p of parts) if (p.type !== 'literal') out[p.type as keyof TimeParts] = p.value
  return out
}

/** 毫秒 → 该时区的 datetime-local 字符串。 */
export function toZonedInput(ms: number, timeZone: string): string {
  const p = partsOf(ms, timeZone)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** 毫秒 → 该时区的 月-日 时:分。 */
export function toZonedShort(ms: number, timeZone: string): string {
  const p = partsOf(ms, timeZone)
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/** 该时区在某一时刻的偏移（毫秒），只按分钟精度算。 */
function zoneOffsetMs(timeZone: string, at: number): number {
  const p = partsOf(at, timeZone)
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute)
  return asUtc - Math.floor(at / 60_000) * 60_000
}

/** 该时区的 datetime-local 字符串 → UTC 毫秒，按两轮修正跨 DST。 */
export function fromZonedInput(input: string, timeZone: string): number {
  const asUtc = Date.parse(`${input}:00Z`)
  if (Number.isNaN(asUtc)) return NaN
  const guess = asUtc - zoneOffsetMs(timeZone, asUtc)
  return asUtc - zoneOffsetMs(timeZone, guess)
}
