// SPDX-License-Identifier: AGPL-3.0-only
import type { ChangeRow, EventRow } from '../types';
import type { ColumnPatch } from './validate';

/** 日程数据库操作（A-2）：D1 无事务，并发靠带版本号的条件 UPDATE，流水独立 INSERT 失败不影响主表。 */

/** 查一条（含软删的行，调用方自己判 deleted_at）。 */
export async function findEvent(db: D1Database, id: string): Promise<EventRow | null> {
  return await db.prepare('SELECT * FROM calendar_events WHERE id = ?').bind(id).first<EventRow>();
}

/** 条件更新：id、版本号、未删除三者同时对得上才落库，返回受影响行数。 */
export async function updateEventConditional(
  db: D1Database,
  id: string,
  expectedVersion: number,
  columns: ColumnPatch[],
  updatedAt: number,
): Promise<number> {
  if (columns.length === 0) {
    return 0;
  }
  // 列名来自 validate 的白名单映射，不是用户输入；这里是唯一的 SQL 拼接点
  const setClause = columns.map(({ column }) => `${column} = ?`).join(', ');
  const values = columns.map(({ value }) => value);
  const result = await db
    .prepare(
      `UPDATE calendar_events
          SET ${setClause}, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    )
    .bind(...values, updatedAt, id, expectedVersion)
    .run();
  return result.meta.changes ?? 0;
}

/** 写一条变更记录（独立 INSERT，失败不回滚主表）。 */
export async function insertChange(
  db: D1Database,
  change: {
    id: string;
    eventId: string;
    actorId: string;
    actorName: string;
    fromVersion: number;
    toVersion: number;
    changedFields: string[];
  },
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO calendar_event_changes
        (id, event_id, actor_id, actor_name, from_version, to_version, changed_fields, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      change.id,
      change.eventId,
      change.actorId,
      change.actorName,
      change.fromVersion,
      change.toVersion,
      JSON.stringify(change.changedFields),
      now,
    )
    .run();
}

/** 该日程最近一条变更的操作者名，供 409 让前端显示撞车的人。 */
export async function findLatestActorName(
  db: D1Database,
  eventId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT actor_name FROM calendar_event_changes
        WHERE event_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
    .bind(eventId)
    .first<{ actor_name: string }>();
  return row?.actor_name ?? null;
}

/** 变更流：since 之后（含当毫秒）的流水，可排除某条日程；重复尾由前端去重。 */
export async function listChanges(
  db: D1Database,
  since: number,
  excludeEventId: string | null,
  limit: number,
): Promise<ChangeRow[]> {
  // where 只取自下面两个固定串，不拼用户输入
  const where = excludeEventId
    ? 'created_at >= ? AND event_id != ?'
    : 'created_at >= ?';
  const binds = excludeEventId ? [since, excludeEventId, limit] : [since, limit];
  const result = await db
    .prepare(
      `SELECT * FROM calendar_event_changes
        WHERE ${where}
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
    .bind(...binds)
    .all<ChangeRow>();
  return result.results;
}
