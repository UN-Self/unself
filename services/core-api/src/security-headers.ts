// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 外壳 HTML 的安全响应头（决策 #47，M1 复核 S8 落地）：
 * - `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN`：挡点击劫持（第三方页面套壳）
 * - 基础 CSP：`default-src 'self'` 家族，收紧注入面
 *
 * 分工（为什么不是一处）：静态资产路径（`/`、SPA 深链）由 Cloudflare 资产服务直出，
 * 头写在 `apps/shell/public/_headers`（构建产物里）；而 `/setup*` 走 Worker（run_worker_first），
 * 其 HTML 由 core Worker 入口回退 ASSETS 得到 → 必须在这里补同一套头，否则该路径裸奔。
 * 两处共用本文件导出的常量，避免值漂移。
 *
 * 已知取舍：`style-src` 保留 `'unsafe-inline'`（Vue 运行时可能注入样式，拿掉有白屏风险）；
 * 只作用于 `text/html` 响应，API 的 JSON 不加（无意义且白白增大响应）。
 */

import type { Context, Next } from 'hono';

/** CSP 指令集（顺序固定：便于 `_headers` 与本文件逐字对齐、测试断言稳定）。 */
export const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** 兼容不支持 `frame-ancestors` 的老浏览器；`DENY` 会连自家 iframe 一起挡，故用 `SAMEORIGIN`。 */
export const HTML_FRAME_OPTIONS = 'SAMEORIGIN';

const HTML_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Content-Security-Policy', HTML_CSP],
  ['X-Frame-Options', HTML_FRAME_OPTIONS],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
];

function isHtml(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
}

/**
 * 给 HTML 响应补安全头（纯函数形态：便于单测直接断言行为，不必起 Worker）。
 * 幂等：已有同名头（如静态资产 `_headers` 已加）时原样保留，不覆盖。
 * 非 HTML（JSON/二进制/空体）原样返回，不改动 Response 对象本身。
 */
export function withHtmlSecurityHeaders(response: Response): Response {
  if (!isHtml(response)) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of HTML_HEADERS) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Hono 中间件形态：给经 app 返回的 HTML 响应补头（当前 app 只出 JSON，
 * 留着是因为「谁回 HTML 谁上头」比「记得在某处手动调」更不容易漏）。
 */
export function htmlSecurityHeaders() {
  return async (c: Context, next: Next): Promise<void> => {
    await next();
    const patched = withHtmlSecurityHeaders(c.res);
    if (patched !== c.res) c.res = patched;
  };
}
