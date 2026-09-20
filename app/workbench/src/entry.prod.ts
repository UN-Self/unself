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
 * #279：壳 HTML 过去以 application/octet-stream 存储（上传 part 类型写死），#273 曾在此对「导航请求
 * 命中非 HTML 资产」现场改写成 text/html 兜底（asHtmlDocument）。MIME 已在上传侧修对（rest/mime.ts），
 * 该兜底**删除**：它会把 JS/CSS/图片在带 `Accept: text/html` 的导航下谎报成 text/html，
 * 更会把「资产类型又退化成 octet-stream」的回归藏起来（HTML 照常、只有 module 脚本白屏）。
 * 现在「类型写错」直接原样透出——宁可显式故障，不要伪装。
 */
import { createStalwartMailProvisioner, toStalwartProvisionerConfig } from '@unself/stalwart-provisioner';

import { createApp, type Bindings } from './index';
import { registryFrameOrigins } from './registry';
import { withHtmlSecurityHeaders } from './security-headers';

/** 运行期绑定 = app 自身绑定 + 静态资产（装配期由引擎挂上 assets 目录）。 */
export interface ProdEnv extends Bindings {
  ASSETS: Fetcher;
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

export default {
  async fetch(request: Request, env: ProdEnv, ctx: ExecutionContext): Promise<Response> {
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
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) {
      // 只给真 HTML 补头；其余原样透出（#279：不再按 Accept 伪造 text/html）
      return isHtml(asset) ? withHtmlSecurityHeaders(asset, frameOrigins) : asset;
    }
    if (!wantsHtml(request)) return res;
    // 决策 #47：SPA 深链（含 /setup*）的 HTML 不经静态资产的 _headers，在此补同一套头
    // （值同源：security-headers.ts）+ 现场生成的 frame-src 白名单。
    const fallback = await env.ASSETS.fetch(new URL('/', url.origin).toString(), request);
    return withHtmlSecurityHeaders(fallback, frameOrigins);
  },
};
