// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 生命周期骨架（docs/modules.md §8「生命周期」+ core/contracts lifecycle.ts）：
 * `GET /life/export`（导出）、`POST /life/purge`（清除）。
 *
 * 现状是**骨架**：路由已挂、认证已过，业务体回 501 `not_implemented`（显式占位，与
 * app.ts 的五个业务端点同一口径）。全量导出/清除归 D6。
 *
 * 认证与 /api/* 同规（requireAuth 单点收口）：平台侧尚未编排备份，这两个端点目前
 * 只会被带 token 的手工调用打到；无 token 一律 401。
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { requireAuth, type TokenVerifier } from './auth/bearer';
import { ERROR_CODES, ERROR_STATUS, errorBody } from './errors';

export interface LifeAppOptions {
  /** 验签器；`null` = 本进程没有 core 公钥，请求一律 503。 */
  verifier: TokenVerifier | null;
}

const LIFE_ROUTES = [
  { method: 'GET', path: '/life/export' },
  { method: 'POST', path: '/life/purge' },
] as const;

export function createLifeApp(options: LifeAppOptions): Hono {
  const app = new Hono();
  const notImplemented = ERROR_STATUS[ERROR_CODES.notImplemented] as ContentfulStatusCode;

  for (const route of LIFE_ROUTES) {
    app.on(route.method, route.path, async (c) => {
      const auth = await requireAuth({
        authorization: c.req.header('authorization'),
        verifier: options.verifier,
      });
      if (!auth.ok) return c.json(auth.body, auth.status as ContentfulStatusCode);
      return c.json(errorBody(ERROR_CODES.notImplemented), notImplemented);
    });
  }

  return app;
}
