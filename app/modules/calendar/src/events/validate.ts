// SPDX-License-Identifier: AGPL-3.0-only
import type { CalendarEvent, EventStatus, ResponseState } from '../types';
import {
  EDITABLE_FIELDS,
  EVENT_STATUSES,
  MAX_TITLE_LENGTH,
  READONLY_FIELDS,
  RESPONSE_STATES,
  VERSION_FIELD,
  rowToEvent,
} from '../types';
import type { EventRow } from '../types';

/** 编辑请求校验（A-2）：只认 API 名不认列名，只读与未知字段一律拒绝，不做宽容处理。 */

/** 通过校验的补丁：只含请求里真的出现的字段，另带并发令牌。 */
export interface EventPatch {
  title?: string;
  description?: string | null;
  location?: string | null;
  startAt?: number;
  endAt?: number;
  allDay?: boolean;
  timezone?: string;
  status?: EventStatus;
  responseState?: ResponseState | null;
  rrule?: string | null;
  version: number;
}

/** API 名 → 数据库列名（校验通过后才转换，列名来自这里而不是用户输入）。 */
const COLUMN_OF: Record<keyof Omit<EventPatch, 'version'>, string> = {
  title: 'title',
  description: 'description',
  location: 'location',
  startAt: 'start_at',
  endAt: 'end_at',
  allDay: 'all_day',
  timezone: 'timezone',
  status: 'status',
  responseState: 'response_state',
  rrule: 'rrule',
};

/** 单列补丁（交给 SQL 拼接用的白名单列名）。 */
export interface ColumnPatch {
  column: string;
  value: string | number | null;
}

export type ValidateResult =
  | { ok: true; patch: EventPatch; columns: ColumnPatch[]; next: CalendarEvent; changedFields: string[] }
  | { ok: false; error: string; field?: string };

function fail(error: string, field?: string): ValidateResult {
  return field === undefined ? { ok: false, error } : { ok: false, error, field };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** IANA 时区名是否被运行环境认识（不认识的名字 Intl 会直接抛）。 */
function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

/** 校验 PATCH 请求体并合并出最终值：raw 不可信，base 已确认存在且未删除。 */
export function validatePatch(raw: unknown, base: EventRow): ValidateResult {
  if (!isPlainObject(raw)) {
    return fail('body_must_be_object');
  }

  // 并发令牌：必填，正整数
  if (!(VERSION_FIELD in raw)) {
    return fail('version_required', VERSION_FIELD);
  }
  const version = raw[VERSION_FIELD];
  if (!isInteger(version) || version < 1) {
    return fail('version_invalid', VERSION_FIELD);
  }

  const baseEvent = rowToEvent(base);
  const allowed = new Set<string>([...EDITABLE_FIELDS, VERSION_FIELD]);

  for (const key of Object.keys(raw)) {
    if (READONLY_FIELDS.includes(key as (typeof READONLY_FIELDS)[number])) {
      return fail('readonly_field', key);
    }
    if (!allowed.has(key)) {
      return fail('unknown_field', key);
    }
  }

  const patch: EventPatch = { version };
  const columns: ColumnPatch[] = [];

  // title：1-200
  if ('title' in raw) {
    const value = raw.title;
    if (typeof value !== 'string') return fail('title_must_be_string', 'title');
    const trimmed = value.trim();
    if (trimmed.length < 1) return fail('title_required', 'title');
    if (trimmed.length > MAX_TITLE_LENGTH) return fail('title_too_long', 'title');
    patch.title = trimmed;
  }

  // description / location / rrule：字符串或 null
  for (const field of ['description', 'location', 'rrule'] as const) {
    if (!(field in raw)) continue;
    const value = raw[field];
    if (value !== null && typeof value !== 'string') {
      return fail(`${field}_must_be_string_or_null`, field);
    }
    patch[field] = value === null ? null : value;
  }

  if ('startAt' in raw) {
    const value = raw.startAt;
    if (!isInteger(value)) return fail('startAt_must_be_integer_ms', 'startAt');
    patch.startAt = value;
  }
  if ('endAt' in raw) {
    const value = raw.endAt;
    if (!isInteger(value)) return fail('endAt_must_be_integer_ms', 'endAt');
    patch.endAt = value;
  }
  if ('allDay' in raw) {
    const value = raw.allDay;
    if (typeof value !== 'boolean') return fail('allDay_must_be_boolean', 'allDay');
    patch.allDay = value;
  }
  if ('timezone' in raw) {
    const value = raw.timezone;
    if (typeof value !== 'string' || !isValidTimezone(value)) {
      return fail('timezone_invalid', 'timezone');
    }
    patch.timezone = value;
  }
  if ('status' in raw) {
    const value = raw.status;
    if (typeof value !== 'string' || !EVENT_STATUSES.includes(value as EventStatus)) {
      return fail('status_invalid', 'status');
    }
    patch.status = value as EventStatus;
  }
  if ('responseState' in raw) {
    const value = raw.responseState;
    if (value !== null) {
      if (typeof value !== 'string' || !RESPONSE_STATES.includes(value as ResponseState)) {
        return fail('responseState_invalid', 'responseState');
      }
    }
    patch.responseState = value === null ? null : (value as ResponseState);
  }

  // 至少改一个业务字段：只有 version 的请求没有意义，还会白写一条空变更记录
  const touched = EDITABLE_FIELDS.filter((field) => field in patch);
  if (touched.length === 0) {
    return fail('empty_patch');
  }

  // 跨字段规则：开始必须早于结束（以合并后的最终值为准，只改一端也要成立）
  const nextStartAt = patch.startAt ?? baseEvent.startAt;
  const nextEndAt = patch.endAt ?? baseEvent.endAt;
  if (nextStartAt >= nextEndAt) {
    return fail('start_must_be_before_end', patch.startAt !== undefined ? 'startAt' : 'endAt');
  }

  // 合并出最终值：被改动的字段覆盖到 base 上（?? null 不会把 false/0 变成 null）
  const next: CalendarEvent = { ...baseEvent };
  const merged = next as unknown as Record<string, unknown>;
  for (const field of touched) {
    merged[field] = patch[field] ?? null;
  }

  const changedFields = diffFields(baseEvent, next);

  // 业务字段真的没变：不写库、不写流水，直接回当前值（幂等）
  if (changedFields.length === 0) {
    return { ok: true, patch, columns: [], next: baseEvent, changedFields: [] };
  }

  for (const field of touched) {
    const column = COLUMN_OF[field];
    const value = toColumnValue(field, patch);
    columns.push({ column, value });
  }

  return { ok: true, patch, columns, next, changedFields };
}

/** API 值 → 列值（allDay 布尔转 0/1，其余原样）。 */
function toColumnValue(field: keyof Omit<EventPatch, 'version'>, patch: EventPatch): string | number | null {
  if (field === 'allDay') {
    return patch.allDay === true ? 1 : 0;
  }
  const value = patch[field];
  if (value === undefined) {
    return null;
  }
  return value as string | number | null;
}

/** 哪些 API 字段在两次值之间不同（空数组 = 无变化）。 */
export function diffFields(before: CalendarEvent, after: CalendarEvent): string[] {
  return EDITABLE_FIELDS.filter((field) => !sameValue(before[field], after[field]));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
