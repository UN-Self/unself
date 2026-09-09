// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';

import { readSession } from '../session';
import type { Bindings } from '../index';

/**
 * 管理员守卫（可挂载 Hono 中间件）：注册表写操作与全量列表仅限 admin 角色（§2 角色）。
 * 无会话回 401、非 admin 回 403；放行则继续下一处理器。
 * 用法：`app.use('/api/admin/modules*', requireAdmin())`——路径级挂载，一挂一域。
 */
export function requireAdmin(): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const session = await readSession(c);
    if (!session) {
      return c.json({ error: 'authentication required' }, 401);
    }
    const roleRow = await c.env.CORE_DB.prepare('SELECT role FROM users WHERE id = ?')
      .bind(session.uid)
      .first<{ role: string }>();
    if (roleRow?.role !== 'admin') {
      return c.json({ error: 'admin required' }, 403);
    }
    await next();
  };
}
