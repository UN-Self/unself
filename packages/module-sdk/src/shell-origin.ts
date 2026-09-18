// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 壳 origin 解析（#277）：workers.dev 形态下模块被壳跨子域 iframe 嵌入，
 * 模块自身的 location.origin 是「模块子域」而非「壳子域」——把 coreOrigin
 * 写死成 location.origin 会让模块把自己当成 core，postMessage 握手必然失败。
 * 模块统一调 resolveShellOrigin() 取壳 origin，取值优先级：
 *   ① location.ancestorOrigins[0] —— 浏览器给的祖先 origin，跨子域可用（Firefox 无此 API）；
 *   ② wrapper 注入的 <meta name="unself-shell-origin" content="…"> —— CSP 安全的显式声明；
 *   ③ location.origin —— 非 iframe 直开 / 无注入场景回落。
 * 过滤规则：空串、全空白、字面量 'null'（sandboxed opaque origin 的序列化值）
 * 一律视为无效并继续降级；取到的值 trim()。
 * 任何 API 缺失都安静降级（不抛错），彻底无源可取时返回 undefined。
 */

/** 壳 origin 的 meta 注入名（wrapper 侧注入、模块侧查询，两侧共用此契约常量）。 */
export const SHELL_ORIGIN_META_NAME = 'unself-shell-origin';

/**
 * 结构化最小访问面（本包 tsconfig 无 DOM lib）。与 client.ts 的 WindowLike/DocumentLike
 * 同风格，但从 globalThis 取值 + 全可选成员 + typeof 守卫——绝不 `declare const window`，
 * 避免与 client.ts 的同名声明冲突。
 */
interface LocationLike {
  readonly origin?: string;
  readonly ancestorOrigins?: { readonly [index: number]: string | undefined };
}

interface DocumentLike {
  readonly querySelector?: (
    selectors: string,
  ) => { readonly getAttribute?: (name: string) => string | null } | null;
}

/** 无效 origin：非字符串 / 空串 / 全空白 / 字面量 'null'（opaque origin 序列化）。 */
function isValidOrigin(value: string | null | undefined): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return trimmed !== '' && trimmed !== 'null';
}

/**
 * 解析当前模块所处的壳（embedding page）origin。
 * 优先级：ancestorOrigins > meta 注入 > location.origin；取不到返回 undefined。
 */
export function resolveShellOrigin(): string | undefined {
  const g = globalThis as { readonly location?: LocationLike; readonly document?: DocumentLike };

  // ① 浏览器提供的祖先 origin（Chromium/WebKit；Firefox 无此 API → 自然落 ②）。
  const firstAncestor = g.location?.ancestorOrigins?.[0];
  if (isValidOrigin(firstAncestor)) {
    return firstAncestor.trim();
  }

  // ② wrapper 显式注入的 meta 声明（跨浏览器可用，CSP 友好）。
  const metaContent =
    g.document
      ?.querySelector?.(`meta[name="${SHELL_ORIGIN_META_NAME}"]`)
      ?.getAttribute?.('content') ?? null;
  if (isValidOrigin(metaContent)) {
    return metaContent.trim();
  }

  // ③ 非 iframe 直开 / 无注入：回落自身 origin；
  //    自身也是 'null'/缺失（sandboxed、Node 侧）则返回 undefined。
  const own = g.location?.origin;
  return isValidOrigin(own) ? own.trim() : undefined;
}
