// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';

import { generateInstanceKeyPair } from './keys';
import { requireAdmin } from './middleware/admin';
import { registerAuthRoutes } from './routes/auth';
import { registerModuleRoutes } from './routes/modules';
import { registerSetupRoutes } from './routes/setup';
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

// 部署/首启自检：生成新 ES256 密钥对打印给部署者（privateKeyPem → wrangler secret）。
// 进程自身不持 CF 凭证、不落盘（§5.5：装配只在部署时执行）。
app.post('/api/admin/bootstrap-keygen', async (c) => {
  const pair = await generateInstanceKeyPair();
  return c.json({
    hint: '把 privateKeyPem 写入 wrangler secret JWT_PRIVATE_KEY 后重部署；publicKeyPem 备查',
    ...pair,
  });
});

/** 当前会话用户（shell 判断登录态 / #10-13 前端用）。 */
app.get('/api/me', async (c) => {
  const session = await readSession(c);
  if (!session) {
    return c.json({ authenticated: false }, 401);
  }
  return c.json({
    authenticated: true,
    user: { id: session.uid, name: session.name, issuer: session.iss, sub: session.sub },
  });
});

// ---------------------------------------------------------------------------
// 路由域挂载（一域一文件；组合根只做组装，不写业务）
// ---------------------------------------------------------------------------
registerAuthRoutes(app);
registerSetupRoutes(app);
// 注册表写操作与全量列表仅限 admin（§2 角色）；路径级挂载，一挂一域。
app.use('/api/admin/modules*', requireAdmin());
registerModuleRoutes(app);

export default app;
