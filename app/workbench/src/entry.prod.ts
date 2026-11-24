// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cloudflare Worker 生产组合根（#303：从 installer 的入口模板搬来，成为**普通源文件**）。
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
 * 所有请求（含壳 HTML 与静态资产）都经本入口——请求链路（取资产 → SPA 回退 → 安全头 →
 * frame-src 白名单）已抽到 `./prod-handler`，与 Node 运行体共用同一份实现（#360）。
 */
import { createStalwartMailProvisioner, toStalwartProvisionerConfig } from '@unself/stalwart-provisioner';

import { createApp } from './index';
import { handleProdRequest, type ProdEnv } from './prod-handler';

/** DO 类必须由主模块导出（wrangler durable_objects 的 class_name 解析依赖它）；#349 隧道面。 */
export { TunnelRoom } from './do/TunnelRoom';

/** 测试/dev 入口沿用这里的出口；实现已抽到运行体无关的 prod-handler（#360）。 */
export { tryTunnelDataPlane, type ProdEnv } from './prod-handler';

// `CreateMailProvisioner` 收 `unknown`（契约不认适配器形状）→ 在适配器侧收口校验，缺字段当场抛结构化失败。
const app = createApp({
  createMailProvisioner: (cfg) => createStalwartMailProvisioner(toStalwartProvisionerConfig(cfg)),
});

export default {
  async fetch(request: Request, env: ProdEnv, ctx: ExecutionContext): Promise<Response> {
    return handleProdRequest(app, request, env, ctx);
  },
};
