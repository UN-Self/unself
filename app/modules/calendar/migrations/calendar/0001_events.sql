-- SPDX-License-Identifier: AGPL-3.0-only
-- 日历改功能：日程主表 + 变更流水表
-- 时间字段存 UTC 毫秒（INTEGER）；changed_fields 存 JSON 数组，元素用 API 字段名
-- 迁移只增不改：已执行过的文件不能修改（改了也不会重跑）

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL,
  organizer_id TEXT NOT NULL,
  response_state TEXT,
  rrule TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_uid_idx
  ON calendar_events (uid);

CREATE INDEX IF NOT EXISTS calendar_events_organizer_idx
  ON calendar_events (organizer_id);

CREATE INDEX IF NOT EXISTS calendar_events_start_idx
  ON calendar_events (start_at);

CREATE TABLE IF NOT EXISTS calendar_event_changes (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  changed_fields TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS calendar_event_changes_created_idx
  ON calendar_event_changes (created_at, id);

CREATE INDEX IF NOT EXISTS calendar_event_changes_event_idx
  ON calendar_event_changes (event_id, created_at);
