// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 生产组合根（#303：从 installer 的入口模板搬来，成为**普通源文件**）。
 *
 * 为什么在包里而不是部署工具里：本文件说的全是「这个 app 怎么被装成一个 Worker」——
 * 组合 `./index`（路由）、注入真 Stalwart 适配器、给 HTML 补同一套安全头、按注册表现场生成
 * frame-src 白名单。这些知识只有包自己该有；部署工具（installer）只需拿走 `dist/worker.js`。
 * 搬来之前的形态是「installer 在临时目录生成一份带相对路径的入口再 esbuild」——
 * 那套临时目录 / 相对路径换算 / `rootDir` 参数，根因就是打包方站在 app 外面（#303 决策）。
 *
 * 组合根的要求（#141 返工）：deploy 是唯一生产装配点——这里 `createApp` 注入真 Stalwart 适配器；
 * `./index` 自身不再模块级固化无参实例（那会把 members.ts 的契约回退假实现带进生产开户路径）。
 *
 * #273：workers.dev 形态下 core 资产 run_worker_first=true（见引擎 coreRunWorkerFirst），
 * 所有请求（含壳 HTML 与静态资产）都经本入口——入口先按原路径取资产（保持直出语义），
 * 再对 HTML 下发按注册表生成的 frame-src 白名单（跨子域模块 iframe 需壳响应头含模块 origin）。
 *
 * 2026-09-22 实测：ASSETS 的 SPA 回退可直接返回 200 + octet-stream，不能只修 404 分支。
 * 已知页面与 JS/CSS 的旧 MIME 按资源路径修复；不根据 Accept 把任意文件伪装成 HTML。
 * 两种域名形态都经本入口处理，避免自有域静态资产绕过修复。
 */
import { createStalwartMailProvisioner, toStalwartProvisionerConfig } from '@unself/stalwart-provisioner';

import { createApp, type Bindings } from './index';
import { normalizeAssetResponse } from './asset-response';
import { registryFrameOrigins } from './registry';
import { withHtmlSecurityHeaders } from './security-headers';
import { TUNNEL_INTERNAL_ORIGIN, TUNNEL_STRIPPED_REQUEST_HEADERS } from './do/TunnelRoom';

/** DO 类必须由主模块导出（wrangler durable_objects 的 class_name 解析依赖它）；#349 隧道面。 */
export { TunnelRoom } from './do/TunnelRoom';

/** 运行期绑定 = app 自身绑定 + 静态资产（装配期由引擎挂上 assets 目录）+ 隧道 DO（#349）。 */
export interface ProdEnv extends Bindings {
  ASSETS: Fetcher;
  /** connect 反连隧道 DO（#349 决策 #109）：未绑定 = /m/<id> 隧道路由按 503 人话兜底。 */
  CONNECT_TUNNEL?: DurableObjectNamespace;
}

// `CreateMailProvisioner` 收 `unknown`（契约不认适配器形状）→ 在适配器侧收口校验，缺字段当场抛结构化失败。
const app = createApp({
  createMailProvisioner: (cfg) => createStalwartMailProvisioner(toStalwartProvisionerConfig(cfg)),
});

const isHtml = (res: Response): boolean =>
  (res.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
const isApiPath = (p: string): boolean =>
  p.startsWith('/api/') || p.startsWith('/life/') || p.startsWith('/.well-known/');
const wantsHtml = (request: Request): boolean => (request.headers.get('accept') ?? '').includes('text/html');

/** connect 反连数据面（#349）：/m/<id>/… 命中且 CONNECT_TUNNEL 在位 → 经隧道转发。 */
export async function tryTunnelDataPlane(request: Request, env: ProdEnv): Promise<Response | null> {
  const url = new URL(request.url);
  // 接入模式分流（决策 #104 双形态）：/m/<id>/* 同一段路由既可能是直连模块（CF worker
  // 自己接 zone 路由），也可能是 connect 反连模块（隧道出口）。core 在 workers.dev 形态
  // 下不接 /m/*（模块自有子域根挂载）；domain 形态下 core 的 <domain>/* 全吞所有路由
  // （#59 实证），必须按 registry mode 列（0012 既有列，非 T1 范围）识别 connect 模块
  // ——只对 mode='connect' 的 id 走隧道转发，直连模块路由零影响。查询未命中（未知 id）
  // 也返回 null，让请求走既有 404 面（不扩大隧道面的接管范围）。
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
  // 前缀在 core 侧剥掉：模块恒挂根路径（#63 不变式），模块无需知道自己的 /m/<id>/ 外部名
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

export default {
  async fetch(request: Request, env: ProdEnv, ctx: ExecutionContext): Promise<Response> {
    // 隧道数据面先行（路由命中顺序注释）：/m/<id>/* 且 registry mode='connect' → 隧道转发，
    // 不落 SPA assets 兜底（connect 模块无壳内资产，SPA 回 index.html 只会答错页面）；
    // 503/504 人话在 TunnelRoom。直连模块（mode != 'connect'）零影响，走既有链路。
    const tunnel = await tryTunnelDataPlane(request, env);
    if (tunnel) return tunnel;
    const res = await app.fetch(request, env, ctx);
    if (res.status !== 404 || !env.ASSETS) return res;
    const url = new URL(request.url);
    // API/生命周期路径保持 JSON 404；页面导航回退 SPA
    if (isApiPath(url.pathname) || request.method !== 'GET') {
      return res;
    }
    // 决策 #63/#73 + #273：壳 HTML 的 frame-src 白名单按注册表现为生成（跨子域模块 iframe 的唯一放行口）。
    // CORE_DB 未绑定（单测/异常环境）→ 零白名单，安全默认（绝不 frame-src *）。
    const frameOrigins = env.CORE_DB
      ? await registryFrameOrigins(env.CORE_DB, { selfOrigin: url.origin })
      : [];
    // run_worker_first=true（workers.dev 形态）后静态资产也经本入口：先按原路径取资产（保持直出语义）。
    const asset = normalizeAssetResponse(await env.ASSETS.fetch(request), url.pathname);
    if (asset.status !== 404) {
      // 包含资产服务已经完成 SPA 回退的 200 响应。
      return isHtml(asset) ? withHtmlSecurityHeaders(asset, frameOrigins) : asset;
    }
    if (!wantsHtml(request)) return res;
    // 决策 #47：SPA 深链（含 /setup*）的 HTML 不经静态资产的 _headers，在此补同一套头
    // （值同源：security-headers.ts）+ 现场生成的 frame-src 白名单。
    // Worker-first 的 `/setup*` 深链不依赖资产服务的 SPA 回退实现；显式取 index.html，
    // 否则某些部署形态会把 `/setup` 当成缺失文件返回 404，浏览器无法进入激活页。
    const fallback = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin), request));
    if (fallback.status === 404) return res;
    return withHtmlSecurityHeaders(normalizeAssetResponse(fallback, '/index.html'), frameOrigins);
  },
};
