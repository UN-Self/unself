// SPDX-License-Identifier: AGPL-3.0-only
/**
 * docs 模块的 Hono 装配（issue #358）。
 *
 * 本文件只做三件事：
 * 1. **认证**：每个端点先过 `requireAuth`——401 / 503 语义在这里锁死；
 * 2. **路由登记**：按 `routes.ts` 的表格挂载，方法/路径写错测试就红；
 * 3. **结果翻译**：业务体（documents.ts）返回「结果」，这里翻成状态码 + 响应体。
 *
 * 业务体不碰 Hono，所以能脱离 HTTP 直接验；状态码与错误码的对应只在 errors.ts 出现一次。
 * 公钥由部署期注入的 `CORE_JWKS_JSON` 提供（入口 node.ts 建验签器后传入），缺它回 503。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { D1Like } from './d1';
import { requireAuth, type TokenVerifier } from './auth/bearer';
import {
  createDocumentAction,
  deleteDocumentAction,
  getDocumentAction,
  listDocumentsAction,
  saveDocumentAction,
} from './documents';
import { ERROR_STATUS, errorBody, versionConflict, type ErrorCode } from './errors';
import { DOCS_ROUTES } from './routes';

export interface CreateDocsAppOptions {
  /** 验签器；`null` = 本进程没有 core 公钥（装配期没拿到），请求一律 503。 */
  verifier: TokenVerifier | null;
  /** 文档库（node:sqlite 适配器；结构兼容真实 D1Database）。 */
  db: D1Like;
}

type Handler = (c: Context, userId: string) => Promise<Response>;

/** 业务体失败 → 错误响应。code → 状态码只查 errors.ts 的表。 */
function failWith(c: Context, code: ErrorCode): Response {
  return c.json(errorBody(code), ERROR_STATUS[code] as ContentfulStatusCode);
}

/** 请求体解析：不是 JSON（或没有体）时给 null，由业务体回 400，不在装配层抛错。 */
async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * 五个端点的业务体，键 = `方法 路径`，与 routes.ts 的表格逐条对应——表里多一行而这里没有，
 * 装配时当场抛错，不会挂出一个认证通过却什么都不做的端点。
 */
function buildActions(db: D1Like): Record<string, Handler> {
  return {
    'POST /api/docs': async (c, userId) => {
      const result = await createDocumentAction(db, userId, await readJsonBody(c));
      return result.ok ? c.json(result.document, 201) : failWith(c, result.code);
    },
    'GET /api/docs': async (c, userId) => {
      const result = await listDocumentsAction(db, userId, new URL(c.req.url).searchParams);
      return c.json(result.page);
    },
    'GET /api/docs/:id': async (c, userId) => {
      const result = await getDocumentAction(db, c.req.param('id') ?? '', userId);
      return result.ok ? c.json(result.document) : failWith(c, result.code);
    },
    'PUT /api/docs/:id': async (c, userId) => {
      const result = await saveDocumentAction(db, c.req.param('id') ?? '', userId, await readJsonBody(c));
      if (result.ok) return c.json(result.document);
      if (!result.ok && 'current' in result) {
        const status = ERROR_STATUS[result.code] as ContentfulStatusCode;
        return c.json(versionConflict(result.current), status);
      }
      return failWith(c, result.code);
    },
    'DELETE /api/docs/:id': async (c, userId) => {
      const result = await deleteDocumentAction(db, c.req.param('id') ?? '', userId);
      return result.ok ? c.body(null, 204) : failWith(c, result.code);
    },
  };
}

/** 装配 docs 应用（纯装配，不建连接、不跑迁移、不碰 env）。 */
export function createDocsApp(options: CreateDocsAppOptions): Hono {
  const app = new Hono();
  const actions = buildActions(options.db);

  for (const route of DOCS_ROUTES) {
    const action = actions[`${route.method} ${route.path}`];
    if (action === undefined) throw new Error(`路由表有 ${route.method} ${route.path}，但没有对应的业务体`);
    app.on(route.method, route.path, async (c) => {
      const auth = await requireAuth({ authorization: c.req.header('authorization'), verifier: options.verifier });
      if (!auth.ok) return c.json(auth.body, auth.status as ContentfulStatusCode);
      return action(c, auth.claims.sub);
    });
  }

  return app;
}
