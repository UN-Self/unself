// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';

import type { Bindings } from '../index';

/** audit_log 只读视图单行（§6.5 异常排查；target 可为空表示无对象动作）。 */
export interface AuditLogEntry {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  created_at: string;
}

/** 一次最多回看的审计条数（无分页参数，超出的历史靠 D1 控制台直查）。 */
export const AUDIT_LOG_LIMIT = 200;

/**
 * 最近 AUDIT_LOG_LIMIT 条审计，新的在前。
 * 排序以自增 id 为准：同秒内 `datetime('now')` 会打平，id 是唯一稳定的时序。
 */
export async function listAuditLog(db: D1Database): Promise<AuditLogEntry[]> {
  const { results } = await db
    .prepare('SELECT id, actor, action, target, created_at FROM audit_log ORDER BY id DESC LIMIT ?')
    .bind(AUDIT_LOG_LIMIT)
    .all<AuditLogEntry>();
  return results;
}

/** 挂载审计域（/api/admin/audit-log）；admin 守卫由组合根统一挂 `/api/admin/*`。 */
export function registerAuditRoutes(app: Hono<{ Bindings: Bindings }>): void {
  app.get('/api/admin/audit-log', async (c) => c.json(await listAuditLog(c.env.CORE_DB)));
}
