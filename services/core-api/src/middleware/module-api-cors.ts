// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';

import type { Bindings } from '../index';
import { registryFrameOrigins } from '../registry';

/**
 * 模块后端面 CORS（决策 #63/#73）：Core API 按注册表 origin 白名单开 CORS。
 *
 * 消费者是「跨域模块页里的浏览器侧 SDK/页面 JS」——同域路径制下页面 JS 与 core 同源
 * 根本不触发 CORS；只有 external 模块（publicUrl 独立 origin）的浏览器代码需要带
 * 模块 token 直调 /api/module-api/*，浏览器才先发预检。
 *
 * 口径（紧，不是 'true' 反射）：
 * - origin 必须命中「启用模块的 entry origin 白名单」，否则不加任何 ACAO 头——浏览器拦，
 *   服务端兜底仍由 token 门禁把守（白名单/CORS 是浏览器便利，不是鉴权）。
 * - 白名单现场查注册表（每请求）：注册/启停秒级生效，与 frame-src 同一真值源；
 * - `Allow-Origin` 命中时才回 `Allow-Credentials: true`（带 Authorization 头的请求不需要
 *   cookie，但显式声明凭证口径，禁止通配反射）；
 * - 预检：OPTIONS（无 Authorization）先于 token 门禁回答，204 + 允许头收敛最小集。
 */

/** 允许的自定义请求头收敛最小集（模块页只带 Authorization；X-Request-Id 便于排障）。 */
export const MODULE_API_ALLOWED_HEADERS = 'Authorization, Content-Type, X-Request-Id';

/** 允许的方法收敛最小集（module-api 面：读存储/写存储/删/列 + notify）。 */
export const MODULE_API_ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

/** 单次 CORS 判定：返回应回的 ACAO 值（命中白名单）或 null（不命中→ 不加头）。 */
export async function moduleApiAllowOrigin(
  db: D1Database,
  requestOrigin: string | null,
): Promise<string | null> {
  if (!requestOrigin) return null;
  const whitelist = await registryFrameOrigins(db);
  return whitelist.includes(requestOrigin) ? requestOrigin : null;
}

/** 挂 /api/module-api/* 的注册表白名单 CORS 中间件（在 requireModuleAuth 之前注册）。 */
export function moduleApiCors(): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const allowOrigin = await moduleApiAllowOrigin(c.env.CORE_DB, c.req.header('origin') ?? null);
    const isPreflight = c.req.method === 'OPTIONS';

    if (isPreflight) {
      // 预检无 Authorization：必须在门禁之前短路回答（204 + 收敛后的 Allow-* 面）
      const headers = new Headers();
      if (allowOrigin) {
        headers.set('Access-Control-Allow-Origin', allowOrigin);
        headers.set('Access-Control-Allow-Credentials', 'true');
        headers.set('Access-Control-Allow-Methods', MODULE_API_ALLOWED_METHODS);
        headers.set('Access-Control-Allow-Headers', MODULE_API_ALLOWED_HEADERS);
        headers.set('Access-Control-Max-Age', '600');
      }
      return new Response(null, { status: 204, headers });
    }

    await next();
    // 实际响应：命中白名单才补 ACAO（未命中 = 浏览器按同源策略拦截，服务端不配合放行）
    if (allowOrigin) {
      c.header('Access-Control-Allow-Origin', allowOrigin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
    }
  };
}
