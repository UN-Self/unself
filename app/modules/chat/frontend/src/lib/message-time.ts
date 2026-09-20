// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 消息时间显示（#218 消息流）：
 * - 气泡内时间：当天 HH:mm；昨天「昨天 HH:mm」；更早「M月D日 HH:mm」（跨年补年份）。
 * - 日期分隔：今天 / 昨天 / M月D日（跨年补年份）。
 * 纯本地时间口径（与消息 createdAt 的展示语义一致，不做时区换算）。
 */

/** 判定与 now 同一自然日（本地时区）。 */
export function isSameDay(date: Date, now: Date): boolean {
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  )
}

function hhmm(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/** 无效时间（NaN / 乱串）显示为空串——宁缺不乱。 */
function parseSafe(iso: string): Date | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** 气泡时间：当天 HH:mm；昨天 前缀；更早 M月D日（同年略年份）。 */
export function formatMessageTime(iso: string, now: Date = new Date()): string {
  const date = parseSafe(iso)
  if (date === null) return ''
  if (isSameDay(date, now)) return hhmm(date)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(date, yesterday)) return `昨天 ${hhmm(date)}`
  const md = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}年${md}`
}

/** 日期分隔条：今天 / 昨天 / M月D日（跨年补年份）。 */
export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const date = parseSafe(iso)
  if (date === null) return ''
  if (isSameDay(date, now)) return '今天'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(date, yesterday)) return '昨天'
  const md = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}年${md}`
}
