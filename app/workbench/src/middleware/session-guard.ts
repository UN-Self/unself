// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';

import type { Bindings } from '../index';
import { getMemberAccess, type MemberAccess } from '../services/members';
import { readSession, type SessionPayload } from '../session';

/**
 * 会话守卫（issue #187，S7 停用即时生效）：「会话成员是否可访问」的**唯一真值点**。
 *
 * 为什么收敛（issue #187 的问题）：会话/模块 token 签出后到期前不可吊销，停用只挡住
 * 「新签发」；此前各路由各自判定 `member?.status === 'disabled'`，漏一处就是一条旁路
 * （通知读侧当时就没有判定，停用成员照常读）。收敛到一个中间件后：每个受保护请求都读
 * 一次 users 的**现行** status，停用/删除在下一次请求即 403，不依赖 token 到期。
 *
 * 语义矩阵：无会话 401；成员行已删或 status != 'active' 403；角色位
 * （非管理员 403）由 `requireAdmin` 在同一判定结果之上叠加。
 * 公开端点（健康检查、JWKS、登录/登出、邀请填表、激活、setup/OIDC 门禁）不挂本中间件，
 * 挂载清单见 index.ts 的「登录态挂载」段。
 */

/** 守卫写入的上下文变量：受保护处理器可复用已判定的会话与成员真值，不再二次查库/二次判定。 */
export interface SessionGuardVariables {
  session: SessionPayload;
  member: MemberAccess;
}

/** 判定所需的最小上下文面（与 Hono Context 结构兼容，便于在任意 Env 上复用）。 */
export interface SessionGuardContext {
  req: { header(name: string): string | undefined };
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY?: string };
}

/** 登录态判定结果：放行（附会话与成员真值）或拒绝（401/403 与错误文案）。 */
export type ActiveMemberAuth =
  | { ok: true; session: SessionPayload; member: MemberAccess }
  | { ok: false; status: 401 | 403; error: string };

/**
 * 真值点本体：验会话 Cookie（HMAC + 过期）→ 读 users 现行 status → 仅 active 放行。
 * 全仓只此一处判定「会话成员是否 active」；路由与其他中间件（requireAdmin）不得重写同语义判定。
 * 已删除与已停用同回 403（不向调用方区分「不存在」与「被停用」）。
 */
export async function authenticateActiveMember(c: SessionGuardContext): Promise<ActiveMemberAuth> {
  const session = await readSession(c);
  if (!session) {
    return { ok: false, status: 401, error: 'authentication required' };
  }
  const member = await getMemberAccess(c.env.CORE_DB, session.uid);
  if (!member || member.status !== 'active') {
    return { ok: false, status: 403, error: 'account disabled' };
  }
  return { ok: true, session, member };
}

/**
 * 登录态守卫（Hono 中间件）：无会话 401、成员停用/已删 403；放行则把判定结果写入上下文
 * （`c.get('session')` / `c.get('member')`）供下游复用。组合根按前缀挂载（见 index.ts）。
 */
export function requireActiveMember(): MiddlewareHandler<{ Bindings: Bindings; Variables: SessionGuardVariables }> {
  return async (c, next) => {
    const auth = await authenticateActiveMember(c);
    if (!auth.ok) {
      return c.json({ error: auth.error }, auth.status);
    }
    c.set('session', auth.session);
    c.set('member', auth.member);
    await next();
  };
}
