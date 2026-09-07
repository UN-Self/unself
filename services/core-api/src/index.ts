// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';

export interface Bindings {
  CORE_DB: D1Database;
  MODULES_DB: D1Database;
  JWT_PRIVATE_KEY?: string;
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/health', (c) => c.json({ ok: true, service: 'core-api' }));

// M0 骨架：租户激活流程尚未实现
app.post('/api/setup/activate', (c) =>
  c.json({ error: 'not implemented (M0 scaffold)' }, 501)
);

// M0 骨架：模块令牌签发尚未实现（M0 用 jose 以 JWT_PRIVATE_KEY 签发模块 JWT）
app.post('/api/modules/:id/token', (c) =>
  c.json({ error: 'not implemented (M0 scaffold)' }, 501)
);

// M0 骨架：JWKS 占位，M0 实现后由 jose 导出公钥
app.get('/.well-known/jwks.json', (c) => c.json({ keys: [] }));

export default app;
