// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 运行体无关的生产请求处理（#360 Node 运行体）：Cloudflare Worker 入口与 Node 入口
 * 共用同一份「隧道数据面 → Hono → 静态资产 → SPA 回退 → 安全头」链路，差别只在
 * `ASSETS` 与 `CONNECT_TUNNEL` 由谁实现（CF 绑定 / Node 适配层）。
 *
 * 为什么必须抽出来而不是各复制一份：SPA 回退补安全头、frame-src 按注册表生成、
 * connect 隧道先于 SPA 兜底——这些是壳的行为契约，两个运行体各写一份必然漂移
 * （#303 已为「入口在 app 外面」付过一次代价）。
 */
import type { ExecutionContext } from 'hono';

import { createApp, type Bindings } from './index';
import { normalizeAssetResponse } from './asset-response';
import { registryFrameOrigins } from './registry';
import { withHtmlSecurityHeaders } from './security-headers';
import { TUNNEL_INTERNAL_ORIGIN, TUNNEL_STRIPPED_REQUEST_HEADERS } from './do/TunnelRoom';

/** 运行期绑定 = app 自身绑定 + 静态资产 + 隧道 DO（#349）。 */
export interface ProdEnv extends Bindings {
  ASSETS: Fetcher;
  /** connect 反连隧道 DO；未绑定 = /m/<id> 隧道路由按 503 人话兜底。 */
  CONNECT_TUNNEL?: DurableObjectNamespace;
}

/** 组合根产物的最小面（Hono app 或 Node 测试替身都满足）。 */
export interface WorkbenchApp {
  fetch(request: Request, env: Bindings, context: ExecutionContext): Response | Promise<Response>;
}

/** `createApp` 的默认依赖（Stalwart 邮件开户适配器）在运行体侧保持同一装配。 */
export type CreateWorkbenchApp = typeof createApp;

const isHtml = (res: Response): boolean =>
  (res.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
const isApiPath = (p: string): boolean =>
  p.startsWith('/api/') || p.startsWith('/life/') || p.startsWith('/.well-known/');
const wantsHtml = (request: Request): boolean => (request.headers.get('accept') ?? '').includes('text/html');

/**
 * connect 反连数据面（#349）：/m/<id>/… 命中且 CONNECT_TUNNEL 在位 → 经隧道转发。
 * 只在 mode='connect' 的 id 上接管（直连模块零影响）；未知 id 回 null 走既有 404 面。
 */
export async function tryTunnelDataPlane(request: Request, env: ProdEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/m/')) return null;
  const ns = env.CONNECT_TUNNEL;
  if (!ns || !env.CORE_DB) return null;
  const moduleId = url.pathname.split('/')[2] ?? '';
  if (!moduleId) return null;
  const row = await env.CORE_DB.prepare('SELECT mode FROM module_registry WHERE id = ?')
    .bind(moduleId)
    .first<{ mode: string | null }>();
  if (row?.mode !== 'connect') return null;
  const stub = ns.get(ns.idFromName(moduleId));
  // 前缀在 core 侧剥掉：模块恒挂根路径（#63 不变式）。
  const innerPath = url.pathname.slice(`/m/${moduleId}`.length) || '/';
  const forwardUrl = new URL(
    `${TUNNEL_INTERNAL_ORIGIN}/forward?target=${encodeURIComponent(innerPath + url.search)}`,
  );
  // 同域隔离（#349 定案）：登录态类头不进模块隧道（DO 转发前还有一次纵深剔除）。
  const headers = new Headers(request.headers);
  for (const name of TUNNEL_STRIPPED_REQUEST_HEADERS) headers.delete(name);
  return stub.fetch(
    new Request(forwardUrl, {
      method: request.method,
      headers,
      body:
        request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
    }),
  );
}

/**
 * 一个请求的完整生产链路（CF Worker 与 Node 运行体共用）：
 * 隧道数据面 → Hono → 404 且非 API/非 GET|HEAD 原样 → 先按原路径取资产 → SPA 深链回退 index.html，
 * HTML 一律补安全头与按注册表生成的 frame-src 白名单。
 */
export async function handleProdRequest(
  app: WorkbenchApp,
  request: Request,
  env: ProdEnv,
  context: ExecutionContext,
): Promise<Response> {
  // 隧道数据面先行：connect 模块无壳内资产，SPA 回 index.html 只会答错页面。
  const tunnel = await tryTunnelDataPlane(request, env);
  if (tunnel) return tunnel;
  const res = await app.fetch(request, env, context);
  if (res.status !== 404 || !env.ASSETS) return res;
  const url = new URL(request.url);
  // API/生命周期路径保持 JSON 404；页面导航（GET 与 HEAD 同路径，body 由运行时按 HEAD 语义丢弃）回退 SPA。
  // CF 上 ASSETS.fetch 对 HEAD 本就先做了回退，这行从未触发；Node 运行体的 AssetsFetcher 不做方法分流，
  // 不故 HEAD 会落到 Hono 的 text/plain 404——健康探针 / 链接预览抓取常用 HEAD，不能让它红。
  if (isApiPath(url.pathname) || (request.method !== 'GET' && request.method !== 'HEAD')) return res;
  // 壳 HTML 的 frame-src 白名单按注册表现为生成；CORE_DB 缺失 = 零白名单（安全默认）。
  const frameOrigins = env.CORE_DB
    ? await registryFrameOrigins(env.CORE_DB, { selfOrigin: url.origin })
    : [];
  // 先按原路径取资产（保持直出语义）；资产服务可能已完成 SPA 回退（200）。
  const asset = normalizeAssetResponse(await env.ASSETS.fetch(request), url.pathname);
  if (asset.status !== 404) {
    return isHtml(asset) ? withHtmlSecurityHeaders(asset, frameOrigins) : asset;
  }
  if (!wantsHtml(request)) return res;
  // SPA 深链显式取 index.html：不依赖各运行体对 `/setup*` 的资产回退实现。
  const fallback = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin), request));
  if (fallback.status === 404) return res;
  return withHtmlSecurityHeaders(normalizeAssetResponse(fallback, '/index.html'), frameOrigins);
}
