// SPDX-License-Identifier: AGPL-3.0-only
import { MAX_TITLE_LENGTH } from '../../../src/types'
import type { CalendarEvent, EventStatus } from '../../../src/types'

export interface EditableDraft {
  title: string
  description: string
  location: string
  startAt: number
  endAt: number
  status: EventStatus
}

/** 前端校验：与后端 validatePatch 同源，只做即时提示，不替代服务端校验。 */
export function validateDraft(draft: EditableDraft): string | null {
  if (!draft.title.trim()) return '标题不能为空'
  if (draft.title.trim().length > MAX_TITLE_LENGTH) return `标题最多 ${MAX_TITLE_LENGTH} 字`
  if (!Number.isInteger(draft.startAt) || !Number.isInteger(draft.endAt)) return '时间格式不对'
  if (draft.startAt >= draft.endAt) return '开始时间必须早于结束时间'
  return null
}

/** 后端 400 的 error 码 → 中文提示；没匹配的按 field 兜底。 */
const ERROR_LABELS: Record<string, string> = {
  title_required: '标题不能为空',
  title_too_long: '标题太长（最多 200 字）',
  title_must_be_string: '标题格式不对',
  version_required: '版本号缺失，请刷新页面',
  version_invalid: '版本号无效，请刷新页面',
  start_must_be_before_end: '开始时间必须早于结束时间',
  startAt_must_be_integer_ms: '开始时间格式不对',
  endAt_must_be_integer_ms: '结束时间格式不对',
  status_invalid: '状态值无效',
  timezone_invalid: '时区格式无效',
  empty_patch: '没有需要保存的改动',
  body_must_be_object: '请求格式不对',
  readonly_field: '包含不可修改的字段',
  unknown_field: '包含未知字段',
}

/** 后端返回的字段名 → 中文，用于 400 兜底提示。 */
const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  description: '描述',
  location: '地点',
  startAt: '开始时间',
  endAt: '结束时间',
  status: '状态',
  timezone: '时区',
  version: '版本号',
}

/** 把后端 400 的 error/field 翻成人话；都不认识就给原始错误码，方便排查。 */
export function describeApiError(code?: string, field?: string): string {
  if (code && ERROR_LABELS[code]) return ERROR_LABELS[code]
  if (field) return `${FIELD_LABELS[field] ?? field}格式不对`
  return code ? `保存失败（${code}）` : '保存失败，请稍后再试'
}

/** 本地草稿与服务端最新值逐字段对比，得出 409 要展示的字段。 */
export function diffEditableFields(local: EditableDraft, latest: CalendarEvent): string[] {
  const fields: string[] = []
  if (local.title !== latest.title) fields.push('title')
  if (local.startAt !== latest.startAt) fields.push('startAt')
  if (local.endAt !== latest.endAt) fields.push('endAt')
  if (local.location !== latest.location) fields.push('location')
  if ((local.description || null) !== latest.description) fields.push('description')
  if (local.status !== latest.status) fields.push('status')
  return fields
}
