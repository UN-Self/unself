// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 静态资产 Fetcher（#360）：`entry.prod` 的 `env.ASSETS.fetch(request)` 在 Node 侧的
 * 同形状实现——从构建产物目录读文件，SPA 深链（无扩展名的页面路径）回退 index.html。
 *
 * 保持与 CF 资产服务一致的关键语义：
 * - 已知文件原样直出，MIME 按扩展名定（`asset-response.ts` 仍会在入口侧兜旧类型）；
 * - 页面深链不依赖资产服务的回退实现（入口显式取 /index.html 也有这一层兜底）；
 * - 带扩展名但文件不存在 → 404，不把 JS/CSS 伪装成 HTML（#279）。
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

function contentTypeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function hasExtension(path: string): boolean {
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.includes('.');
}

/** 路径落盘校验：URL pathname 解码后必须仍在根目录内（防 `..` 穿越）。 */
function toDiskPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relativePath = decoded.replace(/^\/+/, '') || 'index.html';
  const full = resolve(root, relativePath);
  if (full !== root && !full.startsWith(`${root}${sep}`)) return null;
  return full;
}

async function readFileOrDirectory(path: string): Promise<Uint8Array | null> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return readFile(resolve(path, 'index.html'));
    return await readFile(path);
  } catch {
    return null;
  }
}

/** 以目录为根创建资产 Fetcher（`dist/web`）。 */
export function createAssetsFetcher(rootDir: string): AssetsFetcher {
  const root = resolve(rootDir);
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = toDiskPath(root, url.pathname);
      if (!path) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      const body = await readFileOrDirectory(path);
      if (body) {
        return new Response(body, {
          status: 200,
          headers: { 'content-type': contentTypeOf(path) },
        });
      }
      // SPA 深链：无扩展名的页面路径回 index.html（CF not_found_handling=single-page-application 语义）。
      if (!hasExtension(url.pathname)) {
        const index = await readFileOrDirectory(resolve(root, 'index.html'));
        if (index) {
          return new Response(index, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
      }
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    },
  };
}
