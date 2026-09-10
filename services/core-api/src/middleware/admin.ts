// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';

import { getMemberAccess } from '../services/members';
import { readSession } from '../session';
import type { Bindings } from '../index';

/**
 * 管理员守卫（可挂载 Hono 中间件）：注册表写操作与全量列表仅限 admin 角色（§2 角色）。
 * 无会话回 401、非 admin 或已停用回 403；放行则继续下一处理器。
 * 组合根统一挂载 `/api/admin/*`；单域也可按路径挂载。
 */
export function requireAdmin(): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const session = await readSession(c);
    if (!session) {
      return c.json({ error: 'authentication required' }, 401);
    }
    const member = await getMemberAccess(c.env.CORE_DB, session.uid);
    if (!member || member.role !== 'admin' || member.status === 'disabled') {
      return c.json({ error: 'admin required' }, 403);
    }
    await next();
  };
}
