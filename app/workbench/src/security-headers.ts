// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 外壳 HTML 的安全响应头（决策 #47，M1 复核 S8 落地）：
 * - `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN`：挡点击劫持（第三方页面套壳）
 * - 基础 CSP：`default-src 'self'` 家族，收紧注入面
 *
 * 分工（为什么不是一处）：静态资产路径（`/`、SPA 深链）由 Cloudflare 资产服务直出，
 * 头写在 `app/workbench/web/public/_headers`（构建产物里）；而 `/setup*` 走 Worker（run_worker_first），
 * 其 HTML 由 core Worker 入口回退 ASSETS 得到 → 必须在这里补同一套头，否则该路径裸奔。
 * 两处共用本文件导出的常量，避免值漂移。
 *
 * 已知取舍：`style-src` 保留 `'unsafe-inline'`（Vue 运行时可能注入样式，拿掉有白屏风险）；
 * 只作用于 `text/html` 响应，API 的 JSON 不加（无意义且白白增大响应）。
 */

import type { Context, Next } from 'hono';

/**
 * 基础 CSP 指令集（顺序固定，便于 `_headers` 与本文件逐字对齐、测试断言稳定）。
 * 含 `frame-src 'self'`（同域路径制基线）；跨域模块 origin 由
 * `htmlCsp(frameOrigins)` 在其后追加成白名单（决策 #63/#73）。
 */
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

/**
 * 外壳 CSP 生成（决策 #63/#73 按注册表白名单动态生成）：
 * `frame-src` 在基础值后追加注册表里跨域模块的 origin——加模块只改注册表、
 * 不必重建外壳；不传或传空 = 零白名单，安全默认，绝不出现 `frame-src *`。
 * 输入必须已归一化为「scheme://host[:port]」形态（归一化归 registryFrameOrigins/normalizeFrameOrigin）。
 */
export function htmlCsp(frameOrigins?: readonly string[]): string {
  if (!frameOrigins || frameOrigins.length === 0) return HTML_CSP;
  return HTML_CSP.replace('frame-src \'self\'', `frame-src 'self' ${frameOrigins.join(' ')}`);
}

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

/** 响应已带 CSP 时的 frame-src 原文抽取（无该指令回 null）。 */
function frameSrcOf(csp: string): string | null {
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('frame-src')) return trimmed;
  }
  return null;
}

/**
 * 把下发 HTML 的 CSP meta 同步为含白名单的最终 frame-src（#247b）：
 * 实测（Chrome 140）meta CSP 与响应头 CSP 取交集——meta 的 default-src 'self' 会兜住 frame-src，
 * 且文档解析后 meta 不可放宽（运行期改写是 no-op），只改响应头不够，必须改解析前的 HTML。
 * meta 已含 frame-src → 原位替换；不含 → 追加到 content 末尾；无 meta → 原文返回（非我们外壳的 HTML 不强塞）。
 */
function rewriteMetaFrameSrc(html: string, frameSrc: string): string {
  const metaPattern = /<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/i;
  const metaTag = html.match(metaPattern)?.[0];
  if (!metaTag) return html;
  if (/frame-src[^;"']*/i.test(metaTag)) {
    return html.replace(metaTag, metaTag.replace(/frame-src[^;"']*/i, frameSrc));
  }
  return html.replace(metaTag, metaTag.replace(/content=("[^"]*)"/i, `$1; ${frameSrc}"`));
}

/**
 * 给 HTML 响应补安全头；给 frameOrigins 时在 CSP `frame-src` 追加白名单
 * （响应自带 CSP：在原值上追加；没有：套生成值）。
 * 同时重写下发 HTML 的 CSP meta frame-src 为同一白名单（#247b：meta∩头部交集，见 rewriteMetaFrameSrc）；
 * meta 已含相同 frame-src 时 body 不变（幂等，流零拷贝）。
 * 其余头与幂等语义不变（同名保留不覆盖；非 HTML 原样返回）。
 */
export async function withHtmlSecurityHeaders(response: Response, frameOrigins?: readonly string[]): Promise<Response> {
  if (!isHtml(response)) return response;
  const headers = new Headers(response.headers);
  const cspWithFrame = frameOrigins ? htmlCsp(frameOrigins) : HTML_CSP;
  const existing = headers.get('Content-Security-Policy');
  if (existing && frameOrigins) {
    // 已有 CSP（如静态资产 _headers 先加）：在原 frame-src 上追加白名单（不重复已含项）
    const frameSrc = frameSrcOf(existing);
    if (frameSrc) {
      const merged = frameSrc
        .split(/\s+/)
        .filter((v) => v && !(frameOrigins as readonly string[]).includes(v))
        .concat([...frameOrigins])
        .join(' ');
      headers.set('Content-Security-Policy', existing.replace(frameSrc, merged));
    } else {
      // 原头没有 frame-src：在最末追加该指令（保守合并不推翻既有策略）
      headers.set('Content-Security-Policy', `${existing}; frame-src 'self' ${frameOrigins.join(' ')}`);
    }
  } else if (!existing) {
    headers.set('Content-Security-Policy', cspWithFrame);
  }
  for (const [name, value] of HTML_HEADERS.filter(([n]) => n !== 'Content-Security-Policy')) {
    if (!headers.has(name)) headers.set(name, value);
  }
  // #247b：同步下发 HTML 的 CSP meta（解析前改写才有效；meta∩头部交集详见 rewriteMetaFrameSrc）。
  // 幂等：meta 已含相同 frame-src 时零拷贝；仅带白名单时才重写（无白名单时 meta 基线自洽）。
  if (frameOrigins && frameOrigins.length > 0) {
    const frameSrc = `frame-src 'self' ${frameOrigins.join(' ')}`;
    const html = await response.text();
    const next = rewriteMetaFrameSrc(html, frameSrc);
    if (next !== html) {
      headers.set('Content-Length', String(new TextEncoder().encode(next).byteLength));
    }
    return new Response(next, { status: response.status, statusText: response.statusText, headers });
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Hono 中间件形态：给经 app 返回的 HTML 响应补头（当前 app 只出 JSON，
 * 留着是因为「谁回 HTML 谁上头」比「记得在某处手动调」更不容易漏）。
 * 可选给 `frameOrigins` 提供者：每个响应现场查注册表（决策 #63 动态——加模块不改外壳）。
 */
export function htmlSecurityHeaders(options?: {
  frameOrigins?: () => Promise<string[]> | string[];
}) {
  return async (c: Context, next: Next): Promise<void> => {
    await next();
    const frameOrigins = options?.frameOrigins ? await options.frameOrigins() : undefined;
    const patched = await withHtmlSecurityHeaders(c.res, frameOrigins);
    if (patched !== c.res) c.res = patched;
  };
}
