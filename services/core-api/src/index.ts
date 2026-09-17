// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';

import { requireAdmin } from './middleware/admin';
import { requireActiveMember, type SessionGuardVariables } from './middleware/session-guard';
import type { ModuleAuthVariables } from './token';
import { registerActivateRoutes } from './routes/activate';
import { registerAuditRoutes } from './routes/audit';
import { registerAuthRoutes } from './routes/auth';
import { registerInviteRoutes } from './routes/invites';
import { registerMemberRoutes } from './routes/members';
import { registerModuleApiRoutes } from './routes/module-api';
import { registerModuleRoutes } from './routes/modules';
import { registerNotificationRoutes } from './routes/notifications';
import { registerSettingsRoutes } from './routes/settings';
import { registerMailTestRoutes } from './routes/mail-test';
import { registerSetupRoutes } from './routes/setup';
import { readMailAccess, type CreateMailProvisioner } from './services/members';
import type { CreateMailSender } from './services/notifications';

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
  /** SMTP 是外部边界：单测注入假 sender 断言开通邮件，缺省 = 真 SMTP 装配（#18）。 */
  createMailSender?: CreateMailSender;
}

export function createApp(dependencies: CoreApiDependencies = {}) {
  const app = new Hono<{ Bindings: Bindings; Variables: SessionGuardVariables }>();

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

  // ---------------------------------------------------------------------------
  // 登录态挂载（唯一真值点 session-guard，见 middleware/session-guard.ts）-----------
  // Hono 中间件只对「之后注册」的路由生效，故守卫必须在下面所有路由定义之前挂。
  // 需要会话的 API 前缀统一走 requireActiveMember：无会话 401、成员停用/已删 403（不等 token 到期）。
  // 公开端点不挂：健康检查、JWKS、/api/auth/*（登录/登出/取盐/方式探测）、/api/invite/*（填表）、
  // /api/activate/*、/api/oidc/test-connection、/api/setup/* 的 token 门禁端点。
  // /api/modules（成员侧启用清单）现状匿名可读，维持既有公开读口径；签发端点单独挂。
  app.use('/api/me', requireActiveMember());
  app.use('/api/notifications/*', requireActiveMember());
  app.use('/api/modules/:id/token', requireActiveMember());
  app.use('/api/setup/activate', requireActiveMember());
  // #165：`/api/admin/*` 一律过 adminGuard——公开 setup-token 签发口已删，不再有豁免路径。
  // adminGuard 内部用同一个 authenticateActiveMember 判定登录态，只在其上叠加角色位。
  app.use('/api/admin/*', requireAdmin());

  app.get('/api/health', (c) => c.json({ ok: true, service: 'core-api' }));

  /**
   * 当前会话用户（shell 判断登录态 / #10-13 前端用；role 供前端能力判断，真值以服务端为准）。
   * #168：mailEnabled/mailPortalUrl 供成员态入口与说明页（登录态 + 非敏感，口径同邀请页公开开关）。
   * #187：登录态与 status 判定由 /api/me 前缀上的会话守卫给出（session/member 来自上下文），
   * 本处理器只做响应整形；未登录 401、停用/已删 403 的形状由守卫统一。
   */
  app.get('/api/me', async (c) => {
    const session = c.get('session');
    const member = c.get('member');
    const mail = await readMailAccess(c.env.CORE_DB);
    return c.json({
      authenticated: true,
      user: { id: session.uid, name: session.name, issuer: session.iss, sub: session.sub, role: member.role },
      mailEnabled: mail.enabled,
      mailPortalUrl: mail.portalUrl,
    });
  });

  // ---------------------------------------------------------------------------
  // 路由域挂载（一域一文件；组合根只做组装，不写业务）
  // ---------------------------------------------------------------------------
  // 路由模块的签名是 `Hono<{ Bindings: Bindings }>`（一域只认 Bindings）；会话守卫的上下文变量
  // 只在本文件的 /api/me 消费。这里对同一实例做一次窄化传给路由注册器（运行期无差异）。
  const routes = app as unknown as Hono<{ Bindings: Bindings }>;
  registerAuthRoutes(routes);
  registerSetupRoutes(routes);
  registerMemberRoutes(routes, dependencies.createMailProvisioner, dependencies.createMailSender);
  // 邀请域：管理端 /api/admin/invites* + 公开填表 /api/invite/<token>（#18）
  registerInviteRoutes(routes, dependencies);
  // 激活域：公开 /api/activate/<token>（#18；登录态无关，链接双证之一）
  registerActivateRoutes(routes, dependencies);
  registerModuleRoutes(routes);
  // 模块后端面（决策 #56）：/api/module-api/* 走 Bearer 模块 token + permissions 门禁，
  // 与用户会话守卫分层（调用者是模块 Worker/SDK 代理，不是浏览器会话）。
  registerModuleApiRoutes(app as unknown as Hono<{ Bindings: Bindings; Variables: ModuleAuthVariables }>);
  registerNotificationRoutes(routes);
  registerAuditRoutes(routes);
  registerSettingsRoutes(routes);
  registerMailTestRoutes(routes, dependencies);

  /**
   * API 前缀未命中 → JSON 404（#116）：§6.5 错误口径——API 层一律 JSON，
   * 不留 Hono 默认的 text/plain "404 Not Found"。SPA 前端路由由 wrangler
   * assets 兕底，不在本 app 的接管范围，其余路径不挂 notFound。
   * `c.json` 构造的响应头部完整（x-request-id 由全局中间件回写保留）。
   */
  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/') || path === '/api' || path.startsWith('/.well-known/')) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.text('404 Not Found', 404);
  });

  return app;
}
