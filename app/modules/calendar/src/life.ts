// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import { requireAuth, type AppEnv } from './auth';
import type { ChangeRow, EventRow } from './types';

/** 生命周期端点（docs/modules.md §9）：导出与清库，认证同业务接口。 */

export async function exportData(c: Context<AppEnv>): Promise<Response> {
  const blocked = await requireAuth(c);
  if (blocked) return blocked;

  const events = await c.env.DB.prepare(
    'SELECT * FROM calendar_events ORDER BY created_at ASC',
  ).all<EventRow>();
  const changes = await c.env.DB.prepare(
    'SELECT * FROM calendar_event_changes ORDER BY created_at ASC',
  ).all<ChangeRow>();

  return c.json({
    version: 1,
    moduleId: 'calendar',
    exportedAt: new Date().toISOString(),
    tables: {
      calendar_events: { schemaVersion: 1, rows: events.results },
      calendar_event_changes: { schemaVersion: 1, rows: changes.results },
    },
    files: [],
  });
}

export async function purgeData(c: Context<AppEnv>): Promise<Response> {
  const blocked = await requireAuth(c);
  if (blocked) return blocked;

  // D1 没有事务：两条 DELETE 各自独立执行，先清流水再清主表
  await c.env.DB.prepare('DELETE FROM calendar_event_changes').run();
  await c.env.DB.prepare('DELETE FROM calendar_events').run();
  return c.json({ ok: true });
}
