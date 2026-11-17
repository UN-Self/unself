// SPDX-License-Identifier: AGPL-3.0-only
/**
 * docs 模块的 Hono 装配（issue #358）。
 *
 * 本文件当前只承担两件事，因为另外两块的数据面还没到位：
 * 1. **认证**：每个端点先过 `requireAuth`——401 / 503 语义现在就锁死；
 * 2. **路由登记**：按 `routes.ts` 的表格挂载，方法/路径写错测试就红。
 *
 * 业务体统一回 501 `not_implemented`：这是**显式占位**，不是假装成功。
 * 为什么占位而不是先写一半：
 * - 鉴权要查 `docs_documents.owner_id` / `docs_document_members.role`，表还没落（T2）；
 * - JWKS 通道没建（T0），认证在 docker 路径拿不到公钥。
 * 两块到位后，这里把 501 换成「裁决 + 仓储调用」，路由与认证不用改。
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { requireAuth, type TokenVerifier } from './auth/bearer';
import { ERROR_CODES, ERROR_STATUS, errorBody } from './errors';
import { DOCS_ROUTES } from './routes';

export interface CreateDocsAppOptions {
  /** 验签器；`null` = 本进程没有 core 公钥（装配期没拿到），请求一律 503。 */
  verifier: TokenVerifier | null;
}

/** 装配 docs 应用（纯装配，不建连接、不跑迁移、不碰 env）。 */
export function createDocsApp(options: CreateDocsAppOptions): Hono {
  const app = new Hono();
  const notImplemented = ERROR_STATUS[ERROR_CODES.notImplemented] as ContentfulStatusCode;

  for (const route of DOCS_ROUTES) {
    app.on(route.method, route.path, async (c) => {
      const auth = await requireAuth({
        authorization: c.req.header('authorization'),
        verifier: options.verifier,
      });
      if (!auth.ok) return c.json(auth.body, auth.status as ContentfulStatusCode);
      // d5 落点：此处接 `decide(resolveRole(...), route.action)` + 仓储调用。
      return c.json(errorBody(ERROR_CODES.notImplemented), notImplemented);
    });
  }

  return app;
}
