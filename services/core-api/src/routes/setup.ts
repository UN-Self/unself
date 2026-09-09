// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { z } from 'zod';

import { readSession } from '../session';
import { generateSetupToken, storeSetupToken, consumeSetupToken, isSetupTokenValid } from '../setup';
import { audit } from '../services/audit';
import { isSetupDone, markSetupDone, persistOidcConfig } from '../services/instance-config';
import { promoteToAdmin } from '../services/users';
import type { Bindings } from '../index';

/** 向导 OIDC 字段（oidc-config 端点）：三件必填，scope 可选（M0 不采集，发现文档过滤）。 */
const OIDC_BODY_SCHEMA = z.object({
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scope: z.string().min(1).optional(),
});

/** 挂载 setup 域（/api/admin/setup-token、/api/setup/*）。 */
export function registerSetupRoutes(app: Hono<{ Bindings: Bindings }>): void {
  /** 部署脚本/自检：生成新一次性 setup token 并入库（打印进部署输出）。 */
  app.post('/api/admin/setup-token', async (c) => {
    const db = c.env.CORE_DB;
    if (await isSetupDone(db)) {
      return c.json({ error: 'setup already completed; sealed forever' }, 409);
    }
    const { token } = generateSetupToken();
    await storeSetupToken(db, token);
    await audit(db, 'system', 'setup_token_issued');
    return c.json({ token, setupUrl: `/setup?token=${token}` });
  });

  /** setup 状态查询（#10 向导页用）：是否已激活 / token 是否仍可用。 */
  app.get('/api/setup/status', async (c) => {
    const db = c.env.CORE_DB;
    const done = await isSetupDone(db);
    if (done) {
      return c.json({ done: true });
    }
    const token = c.req.query('token');
    if (!token) {
      return c.json({ done: false, tokenValid: false });
    }
    const row = await db
      .prepare('SELECT used_at FROM setup_tokens WHERE token = ?')
      .bind(token)
      .first<{ used_at: string | null }>();
    return c.json({ done: false, tokenValid: Boolean(row && !row.used_at) });
  });

  /**
   * 向导 OIDC 字段落库（#55 直线流程第一步）：
   * - 门禁：setup 未封箱 + token 有效（未消费）——只验不消费（可重复提交改填）；
   * - 动作：持久化向导 OIDC 字段 → 返回 loginUrl（next 带回 setup 页）。
   * 落库前置：不然「登录依赖配置、配置依赖激活后写入」鸡生蛋（登录器由表配置才可通）。
   */
  app.post('/api/setup/oidc-config', async (c) => {
    const db = c.env.CORE_DB;
    if (await isSetupDone(db)) {
      return c.json({ error: 'setup already completed; sealed forever' }, 409);
    }
    const token = c.req.query('token') ?? c.req.header('x-setup-token');
    if (!token) {
      return c.json({ error: 'missing setup token' }, 400);
    }
    if (!(await isSetupTokenValid(db, token))) {
      return c.json({ error: 'invalid or already-used setup token' }, 403);
    }
    const body = OIDC_BODY_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'body must include issuer, clientId, clientSecret' }, 400);
    }
    // 严格校验后必落库；audit 只记一次动作（真实写入）。
    if (await persistOidcConfig(db, body.data)) {
      await audit(db, 'system', 'oidc_config_stored');
    }
    const loginUrl = new URL('/api/auth/login', c.req.url);
    loginUrl.searchParams.set('next', `/setup?token=${encodeURIComponent(token)}`);
    return c.json({ ok: true, loginUrl: loginUrl.toString() });
  });

  /**
   * 激活（#55 直线流程第三步）：已登录会话 + 一次性 token（此处消费）→
   * 提权 admin + 封箱 + 审计。旧「无会话 401→loginUrl」路径已删（死锁根源）；
   * 登录在 oidc-config 落库后发起，本端点不再接受 OIDC body。
   * 已激活后一律拒绝（§6.5：已激活后访问 /setup 一律重定向，页面不复存在）。
   */
  app.post('/api/setup/activate', async (c) => {
    const db = c.env.CORE_DB;
    if (await isSetupDone(db)) {
      return c.json({ error: 'setup already completed; sealed forever' }, 409);
    }
    const token = c.req.query('token') ?? c.req.header('x-setup-token');
    if (!token) {
      return c.json({ error: 'missing setup token' }, 400);
    }
    const session = await readSession(c);
    if (!session) {
      // 无会话：纯 401（已登录是提权前提；loginUrl 路径已删，#55）
      return c.json({ error: 'authentication required' }, 401);
    }
    const consumed = await consumeSetupToken(db, token);
    if (!consumed) {
      return c.json({ error: 'invalid or already-used setup token' }, 403);
    }
    await promoteToAdmin(db, session.uid);
    await markSetupDone(db);
    await audit(db, session.uid, 'setup_activated', session.uid);
    return c.json({ ok: true, user: { id: session.uid, name: session.name, role: 'admin' } });
  });
}
