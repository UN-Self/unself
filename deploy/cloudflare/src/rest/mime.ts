// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 资产上传 → serving Content-Type 映射（#279 白屏根因修复）。
 *
 * 契约（CF 官方文档，direct-upload）："The provided `Content-Type` header of each file part
 * will be attached when eventually serving the file."——即 **serving 时的内容类型 = 上传 multipart
 * 每个 part 的 Content-Type**；manifest 契约里只有 hash/size，不携带类型。所以类型必须在**上传时**定好：
 * 写死 `application/octet-stream`（#279 前的形态）→ 浏览器把 `type="module"` 脚本按 MIME 检查拒执行、
 * 把 HTML 当下载 → 白屏（HTTP/curl/JSON API 全绿，只有真人浏览器才现形）。
 *
 * 出处：本表的取值来自 **mime-db standard types**，抽取路径 = wrangler 4.129.0 内置的
 * `mime@3.0.0`（`getContentType` in workers-shared/utils/helpers.ts，2026-09-18 从
 * `node_modules/.pnpm/wrangler@4.129.0_…/node_modules/wrangler/wrangler-dist/cli.js` 实读）；
 * `text/<subtype>` 追加 `; charset=utf-8` 亦与 wrangler 同款。**有意差异**两处，均在下方就地注明：
 *   1) 浏览器 JS 源（js/mjs/cjs/jsx）统一 `text/javascript`（mime-db 给 application/javascript /
 *      application/node / text/jsx）——HTML 规范的 JavaScript MIME type 判定以此为准，
 *      CF 自家 fetch 层 `minimizeSupportedMimeType` 也把 application/javascript 归一为 text/javascript；
 *   2) 未知扩展名兜底 `application/octet-stream`（wrangler 发 `application/null` = 不带 Content-Type）
 *      ——issue #279 明确要求显式兜底、且兜底**绝不能是已知类型的路径**（见 test/asset-content-type.test.ts 的不变式断言）。
 *
 * 一文件一职责：只做「路径 → 类型」的纯函数映射，不碰 fs / 网络 / FormData。
 */

/** 兜底类型：仅当扩展名不在表内时使用（已知类型绝不落这里）。 */
export const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * 扩展名（小写、不含点）→ Content-Type。
 * 只收「部署产物真的会出现的 Web 类型」+ mime-db 同族常见项，不做通用 mime-db 全量复刻。
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  // 文档 / 脚本 / 样式（text/<subtype> 会由 contentTypeForPath 补 charset=utf-8）
  html: 'text/html',
  htm: 'text/html',
  shtml: 'text/html',
  xhtml: 'application/xhtml+xml',
  xht: 'application/xhtml+xml',
  // 有意差异①：js/mjs 规范类型；cjs/jsx 同族（浏览器当脚本执行，mime-db 的 application/node、text/jsx 不可执行）
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  map: 'application/json',
  json5: 'application/json5',
  jsonld: 'application/ld+json',
  webmanifest: 'application/manifest+json',
  xml: 'application/xml',
  xsl: 'application/xml',
  xsd: 'application/xml',
  rng: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'application/toml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  text: 'text/plain',
  conf: 'text/plain',
  def: 'text/plain',
  list: 'text/plain',
  log: 'text/plain',
  in: 'text/plain',
  ini: 'text/plain',
  vtt: 'text/vtt',
  ics: 'text/calendar',
  ifb: 'text/calendar',
  appcache: 'text/cache-manifest',
  manifest: 'text/cache-manifest',

  // 图像
  svg: 'image/svg+xml',
  svgz: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/vnd.microsoft.icon',
  gif: 'image/gif',
  bmp: 'image/bmp',
  apng: 'image/apng',
  tif: 'image/tiff',
  tiff: 'image/tiff',

  // 字体
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  ttc: 'font/collection',
  eot: 'application/vnd.ms-fontobject',

  // 媒体 / 归档 / 其他二进制
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  mpga: 'audio/mpeg',
  mp2: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  ogv: 'video/ogg',
  mp4: 'video/mp4',
  mp4v: 'video/mp4',
  mpg4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
};
// 注意：表内**不出现** application/octet-stream——它是纯兜底（未知扩展名），不是任何已知类型的路径。

/** 取路径扩展名（小写、不含点）：只看 basename 的最后一个点，忽略 query/hash。 */
function extensionOf(path: string): string {
  const clean = path.split(/[?#]/, 1)[0]!;
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * 路径 → 上传 part 的 Content-Type。
 * - 已知扩展名：表内类型（`text/<subtype>` 补 `; charset=utf-8`，与 wrangler 同款）；
 * - 未知扩展名：`application/octet-stream`（兜底；显式，不静默、不猜）。
 */
export function contentTypeForPath(path: string): string {
  const type = CONTENT_TYPES[extensionOf(path)] ?? FALLBACK_CONTENT_TYPE;
  return type.startsWith('text/') && !type.includes('charset') ? `${type}; charset=utf-8` : type;
}

/** 已知映射的扩展名清单（测试用：断言「兜底只走未知扩展名」，不在生产路径调用）。 */
export function knownMimeExtensions(): string[] {
  return Object.keys(CONTENT_TYPES);
}
