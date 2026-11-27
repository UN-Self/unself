// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块页面静态资产（docs/modules.md §2 包格式：页面放包内 assets/）：把包内 assets/ 目录
 * 的文件按请求路径吐出去。模块页面是单页应用，所以「像页面路由」的路径找不到文件时
 * 回 index.html；「像静态资源」的路径（带扩展名、或在产物目录 assets/ 下）找不到就 404。
 *
 * 边界（不归本文件）：
 * - `/api/*`、`/life/*`、`/sdk/*` 是业务/平台路由，这里不认领，交给 Hono；
 * - 只认 GET / HEAD；其他方法不认领。
 * 路径解码后必须仍落在 assets/ 内（逐段解析后比对真实路径），拒绝 `..` 与绝对路径；
 * 解析到文件后再用 realpath 比对一次，目录里若有指向外面的符号链接也读不出去。
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** 本模块的业务/平台路由前缀（首段路径名）：命中就不是页面请求，交给 Hono。 */
const RESERVED_SEGMENTS = ['api', 'life', 'sdk'];

/** vite 的产物目录：其下的文件名带内容哈希，可长缓存；目录本身也「像资源」，找不到不回退。 */
const HASHED_DIR = 'assets';

export type StaticAssets = (request: Request) => Promise<Response | null>;

/** 解码 URL 路径；非法转义按坏请求处理（返回 null）。 */
function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * 页面请求判定：GET/HEAD，且首段路径不是业务/平台前缀。
 * 在**解码后**比较且不分大小写：`/API/docs`、`/%61pi/docs`、`/api`（不带尾斜杠）都算业务路由，
 * 不能被静态层吞成 index.html。
 */
export function isPageRequest(method: string, decodedPath: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const firstSegment = decodedPath.split('/')[1]?.toLowerCase();
  return firstSegment === undefined || firstSegment === '' || !RESERVED_SEGMENTS.includes(firstSegment);
}

/**
 * 文件系统层面不该出现的路径写法，一律当「找不到」：
 * - NUL（`%00`）；
 * - 任一段含 `:`（Windows 的备用数据流 `index.html::$DATA`、盘符 `C:`）；
 * - 任一段以点或空格结尾（Windows 会把它们吞掉，`index.html.` 就等于 `index.html`）。
 */
function hasUnsafeSegment(decodedPath: string): boolean {
  if (decodedPath.includes('\0')) return true;
  return decodedPath.split('/').some((segment) => segment.includes(':') || /[ .]$/.test(segment));
}

/** 像静态资源而不像页面路由的路径：末段带扩展名，或在产物目录下。 */
function looksLikeAsset(decodedPath: string): boolean {
  const segments = decodedPath.split('/');
  const last = segments.at(-1) ?? '';
  return (last.includes('.') && !last.startsWith('.')) || segments[1]?.toLowerCase() === HASHED_DIR;
}

const notFound = () => new Response('Not Found', { status: 404 });

/**
 * 建静态资产供应器。`root` 不存在（没构建前端）时所有请求都回 null，等价于停用——
 * 后端接口不受影响，只是没有页面。
 */
export function serveAssetsFrom(root: string): StaticAssets {
  const base = resolve(root);
  // 真实路径缓存。**「目录不存在」不缓存**：进程可能先起、前端后构建，缓存住 null 会让页面
  // 一直 404 直到重启。目录存在后 realpath 不再变，缓存它即可。
  let realBaseCache: string | null = null;
  const realBaseOf = async (): Promise<string | null> => {
    if (realBaseCache !== null) return realBaseCache;
    realBaseCache = await realpath(base).catch(() => null);
    return realBaseCache;
  };

  return async (request) => {
    const { pathname } = new URL(request.url);
    const decoded = decodePath(pathname);
    if (decoded === null) return new Response('Bad Request', { status: 400 });
    if (!isPageRequest(request.method, decoded)) return null;
    if (hasUnsafeSegment(decoded)) return notFound();

    // 逐段解析后必须仍在 root 内；`..`、绝对路径在这里被挡住
    const target = resolve(base, `.${decoded}`);
    if (target !== base && !target.startsWith(base + sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    const realBase = await realBaseOf();
    if (realBase === null) return null; // 前端未构建：整层停用，交给 Hono

    const index = join(base, 'index.html');
    let file = target === base ? index : target;
    let missing = false;
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    } catch {
      missing = true;
    }
    if (missing) {
      if (looksLikeAsset(decoded)) return notFound(); // 旧哈希的 JS、favicon 之类：干净的 404
      file = index; // 单页应用：页面路由回 index.html
    }

    let realFile: string;
    try {
      realFile = await realpath(file);
    } catch {
      return notFound(); // 连 index.html 都没有 = 前端未构建
    }
    // 解析到文件后再比一次真实路径：目录里的符号链接指不到外面
    if (realFile !== realBase && !realFile.startsWith(realBase + sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    let body: Uint8Array;
    try {
      body = new Uint8Array(await readFile(realFile));
    } catch {
      return notFound();
    }
    const hashedDir = join(realBase, HASHED_DIR) + sep;
    const headers = {
      'content-type': MIME_TYPES[extname(realFile).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': realFile.startsWith(hashedDir) ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
  };
}
