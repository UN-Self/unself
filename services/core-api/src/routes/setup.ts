// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';

import { readSession } from '../session';
import { generateSetupToken, storeSetupToken, consumeSetupToken } from '../setup';
import { audit } from '../services/audit';
import { isSetupDone, markSetupDone, persistOidcConfig } from '../services/instance-config';
import { promoteToAdmin } from '../services/users';
import type { Bindings } from '../index';

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
   * 激活：校验一次性 token + 当前 OIDC 会话，登记首个管理员，永久封死 setup。
   * 可选 JSON body 携带向导录入的 OIDC 字段（camelCase，见 OIDC_CONFIG_KEYS）；
   * 字段非法/缺失则忽略——保持纯 token 激活向后兼容。
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
      // 未登录：提示需先登录（#10 前端带 token 跳 /api/auth/login?next=...）
      const loginUrl = new URL('/api/auth/login', c.req.url);
      loginUrl.searchParams.set('next', `/setup?token=${encodeURIComponent(token)}`);
      return c.json({ error: 'authentication required', loginUrl: loginUrl.toString() }, 401);
    }
    const consumed = await consumeSetupToken(db, token);
    if (!consumed) {
      return c.json({ error: 'invalid or already-used setup token' }, 403);
    }
    // 向导录入的 OIDC 字段落库（consume 成功后、promoteToAdmin 前；字段非法/缺失忽略）
    const oidcBody = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (await persistOidcConfig(c.env.CORE_DB, oidcBody)) {
      await audit(db, session.uid, 'oidc_config_stored');
    }
    await promoteToAdmin(db, session.uid);
    await markSetupDone(db);
    await audit(db, session.uid, 'setup_activated', session.uid);
    return c.json({ ok: true, user: { id: session.uid, name: session.name, role: 'admin' } });
  });
}
