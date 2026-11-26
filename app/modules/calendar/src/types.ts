// SPDX-License-Identifier: AGPL-3.0-only

/** 字段契约：库里 snake_case、对外一律 camelCase（与增删查共用）；时间存 UTC 毫秒，时区另存 IANA 名。 */

/** 标题长度上限（校验口径，前后端同源）。 */
export const MAX_TITLE_LENGTH = 200;

/** 日程状态：confirmed 正常、tentative 待定、cancelled 取消但保留。 */
export const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** 参与者响应状态（iCalendar PARTSTAT 语义）。 */
export const RESPONSE_STATES = ['needs-action', 'accepted', 'tentative', 'declined'] as const;
export type ResponseState = (typeof RESPONSE_STATES)[number];

/** 数据库行（calendar_events）。 */
export interface EventRow {
  id: string;
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  start_at: number;
  end_at: number;
  all_day: number;
  timezone: string;
  organizer_id: string;
  response_state: string | null;
  rrule: string | null;
  status: string;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** 变更流水行（calendar_event_changes）。 */
export interface ChangeRow {
  id: string;
  event_id: string;
  actor_id: string;
  actor_name: string | null;
  from_version: number;
  to_version: number;
  changed_fields: string;
  created_at: number;
}

/** 对外的日程形状（API 名）。 */
export interface CalendarEvent {
  id: string;
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: number;
  endAt: number;
  allDay: boolean;
  timezone: string;
  organizerId: string;
  responseState: ResponseState | null;
  rrule: string | null;
  status: EventStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** 对外的变更形状（GET /api/events/changes 的元素）。 */
export interface EventChange {
  eventId: string;
  actorName: string;
  toVersion: number;
  changedFields: string[];
  createdAt: number;
}

/** 可编辑字段（PATCH 允许出现的业务字段，顺序即变更记录的排序依据）。 */
export const EDITABLE_FIELDS = [
  'title',
  'description',
  'location',
  'startAt',
  'endAt',
  'allDay',
  'timezone',
  'status',
  'responseState',
  'rrule',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** 并发令牌字段：请求必须带，但不是可改字段。 */
export const VERSION_FIELD = 'version';

/** 只读字段：出现在 PATCH 请求里直接 400。 */
export const READONLY_FIELDS = [
  'id',
  'uid',
  'organizerId',
  'createdAt',
  'updatedAt',
  'deletedAt',
] as const;

/** 错误体（400 带 field 指出是哪个字段挂了）。 */
export interface ApiError {
  error: string;
  field?: string;
}

/** 版本冲突体：必须带当前 event，前端直接拿来显示。 */
export interface VersionConflict extends ApiError {
  error: 'version_conflict';
  event: CalendarEvent;
  version: number;
}

/** 把一行数据库记录映射成对外形状。 */
export function rowToEvent(row: EventRow): CalendarEvent {
  return {
    id: row.id,
    uid: row.uid,
    title: row.title,
    description: row.description,
    location: row.location,
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: row.all_day !== 0,
    timezone: row.timezone,
    organizerId: row.organizer_id,
    responseState: (row.response_state as ResponseState | null) ?? null,
    rrule: row.rrule,
    status: row.status as EventStatus,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
