// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';

import type { ModulePermission } from '@unself/contracts';

import type { Bindings } from '../index';
import type { ModuleAuthVariables } from '../token';
import { checkModuleGate } from '../token';

/**
 * 模块门禁（决策 #56）：/api/module-api/* 的 Bearer 模块 token → 验签 + 注册表快照 → permissions。
 *
 * 与 requireActiveMember（会话守卫，用户面）分层：这是模块后端面——调用者是模块
 * Worker（SDK 代理），不是浏览器会话。权限真值 = 服务端注册表 manifest 快照的
 * permissions 声明；token 不携带能力清单（#56 删 caps），声明的存取只信服务端。
 */
export function requireModuleAuth(): MiddlewareHandler<{ Bindings: Bindings; Variables: ModuleAuthVariables }> {
  return async (c, next) => {
    const gate = await checkModuleGate(c.env.CORE_DB, c.env.JWT_PRIVATE_KEY, {
      header: (name) => c.req.header(name),
    });
    if (!gate.ok) {
      return c.json({ error: gate.error }, gate.status as 401 | 403 | 404 | 503);
    }
    c.set('moduleAuth', gate.auth);
    await next();
  };
}

/**
 * 权限检查：处理器在 requireModuleAuth 之上叠加「本端点需要哪个能力词」。
 * 未声明 → 403（「未声明即调用对应 Core API → 403」，issue #243 验收③）。
 */
export function requireModulePermission(permission: ModulePermission): MiddlewareHandler<{ Bindings: Bindings; Variables: ModuleAuthVariables }> {
  return async (c, next) => {
    if (!c.get('moduleAuth').permissions.includes(permission)) {
      return c.json(
        {
          error: `module '${c.get('moduleAuth').moduleId}' lacks required permission '${permission}'`,
        },
        403,
      );
    }
    await next();
  };
}
