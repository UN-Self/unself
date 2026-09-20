// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';

import type { Bindings } from '../index';
import { authenticateActiveMember } from './session-guard';

/**
 * 管理员守卫（可挂载 Hono 中间件）：注册表写操作与全量列表仅限 admin 角色（§2 角色）。
 * 登录态判定（无会话 401、已停用/已删除 403）由 session-guard 的 `authenticateActiveMember`
 * 统一给出——issue #187 起「会话成员是否 active」只此一处；本守卫只在其上叠加角色位
 * （非 admin 403）。因此独立挂载本守卫（不走组合根的会话前缀）时，停用成员同样被拒。
 */
export function requireAdmin(): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const auth = await authenticateActiveMember(c);
    if (!auth.ok) {
      return c.json({ error: auth.error }, auth.status);
    }
    if (auth.member.role !== 'admin') {
      return c.json({ error: 'admin required' }, 403);
    }
    await next();
  };
}
