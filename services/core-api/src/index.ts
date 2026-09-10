// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';

import { requireAdmin } from './middleware/admin';
import { registerAuditRoutes } from './routes/audit';
import { registerAuthRoutes } from './routes/auth';
import { registerMemberRoutes } from './routes/members';
import { registerModuleRoutes } from './routes/modules';
import { registerNotificationRoutes } from './routes/notifications';
import { registerSettingsRoutes } from './routes/settings';
import { registerSetupRoutes } from './routes/setup';
import { getMemberAccess, type CreateMailProvisioner } from './services/members';
import { readSession } from './session';

export { getSigningRuntime } from './keys';

export interface Bindings {
  CORE_DB: D1Database;
  MODULES_DB: D1Database;
  /** 实例签名私钥（PKCS8 PEM）；由部署/首启流程写入 wrangler secret（#14/#16）。 */
  JWT_PRIVATE_KEY?: string;
  /** 开发便利：未跑 setup 时允许环境变量提供 OIDC 配置（生产走 instance_config 表）。 */
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_SCOPE?: string;
}

export interface CoreApiDependencies {
  createMailProvisioner?: CreateMailProvisioner;
}

export function createApp(dependencies: CoreApiDependencies = {}) {
  const app = new Hono<{ Bindings: Bindings }>();

  /**
   * 全局请求 ID（#60 T3）：每个请求生成唯一 `req-` + 16 位 hex，
   * 回写所有响应（含 401/403/503/错误）的 x-request-id，排障对账用。
   * 必须在所有路由之前注册，且最后设置头部以覆盖错误/404 等非 c.* 构造的响应。
   */
  app.use('*', async (c, next) => {
    const requestId = `req-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await next();
    c.header('x-request-id', requestId);
  });

  app.get('/api/health', (c) => c.json({ ok: true, service: 'core-api' }));

  /** 当前会话用户（shell 判断登录态 / #10-13 前端用；role 供前端能力判断，真值以服务端为准）。 */
  app.get('/api/me', async (c) => {
    const session = await readSession(c);
    if (!session) {
      return c.json({ authenticated: false }, 401);
    }
    const member = await getMemberAccess(c.env.CORE_DB, session.uid);
    if (member?.status === 'disabled') {
      return c.json({ error: 'account disabled' }, 403);
    }
    return c.json({
      authenticated: true,
      user: { id: session.uid, name: session.name, issuer: session.iss, sub: session.sub, role: member?.role ?? 'user' },
    });
  });

  // ---------------------------------------------------------------------------
  // 路由域挂载（一域一文件；组合根只做组装，不写业务）
  // ---------------------------------------------------------------------------
  const adminGuard = requireAdmin();
  app.use('/api/admin/*', async (c, next) => {
    if (c.req.path === '/api/admin/setup-token') {
      await next();
      return;
    }
    return adminGuard(c, next);
  });
  registerAuthRoutes(app);
  registerSetupRoutes(app);
  registerMemberRoutes(app, dependencies.createMailProvisioner);
  registerModuleRoutes(app);
  registerNotificationRoutes(app);
  registerAuditRoutes(app);
  registerSettingsRoutes(app);

  return app;
}

const app = createApp();
export default app;
