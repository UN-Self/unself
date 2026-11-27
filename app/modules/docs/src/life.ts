// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 生命周期端点（docs/modules.md §8「生命周期」+ core/contracts lifecycle.ts）：
 * `GET /life/export`（导出）、`POST /life/purge`（清除）。
 *
 * 业务体在 life-data.ts（模块级导出/硬删，面向平台侧操作方）。本文件只做认证与
 * 结果翻译，与 app.ts 同一口径：无 token 401、验签不过 401、没公钥 503。
 * 平台侧尚未编排备份，这两个端点目前只被带 token 的手工调用打到。
 */
import { Hono } from 'hono';

import { requireAuth, type TokenVerifier } from './auth/bearer';
import { exportAllData, purgeAllData } from './life-data';

export interface LifeAppOptions {
  /** 验签器；`null` = 本进程没有 core 公钥，请求一律 503。 */
  verifier: TokenVerifier | null;
  /** 文档库（node:sqlite 适配器；结构兼容真实 D1Database）。 */
  db: import('./d1').D1Like;
  /** 模块 id（manifest.id），进导出包的 moduleId 字段。 */
  moduleId: string;
}

const LIFE_ROUTES = [
  { method: 'GET', path: '/life/export' },
  { method: 'POST', path: '/life/purge' },
] as const;

export function createLifeApp(options: LifeAppOptions): Hono {
  const app = new Hono();

  for (const route of LIFE_ROUTES) {
    app.on(route.method, route.path, async (c) => {
      const auth = await requireAuth({
        authorization: c.req.header('authorization'),
        verifier: options.verifier,
      });
      if (!auth.ok) return c.json(auth.body, auth.status as import('hono/utils/http-status').ContentfulStatusCode);
      if (route.path === '/life/export') {
        return c.json(await exportAllData(options.db, options.moduleId));
      }
      const purged = await purgeAllData(options.db);
      // 破坏性操作留审计痕迹是刻意定案（审查 D6 定）：sub 是核心内部 id，取前 8 位定位
      // 调用者而不整串进日志；这是本模块唯一的请求级身份日志，别处不得效仿扩散。
      console.log(
        `life/purge：清除评论 ${purged.comments}、成员 ${purged.members}、文档 ${purged.documents}（调用者 sub=${auth.claims.sub.slice(0, 8)}…）`,
      );
      return c.json({ ok: true });
    });
  }

  return app;
}
