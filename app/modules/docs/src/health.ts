// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 健康检查（docs/modules.md §8「健康检查」）：`GET /api/health`，冒烟和可达性体检用。
 *
 * 不鉴权、不碰库：调用方（平台体检、部署者 curl）此时未必有模块 token。
 * 响应形状与 hello 同形（`{ ok, service }`），另带模块版本便于排障时对账（hello 没有这一项）。
 */
import { Hono } from 'hono';

export const DOCS_SERVICE_NAME = 'module-docs';

export interface HealthAppOptions {
  /** 模块版本（manifest.version）；拿不到清单时省略。 */
  version?: string;
}

export function createHealthApp(options: HealthAppOptions = {}): Hono {
  const app = new Hono();
  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      service: DOCS_SERVICE_NAME,
      ...(options.version === undefined ? {} : { version: options.version }),
    }),
  );
  return app;
}
