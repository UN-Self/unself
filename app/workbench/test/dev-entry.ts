// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 本地完整形态 dev 入口（#182）：wrangler dev 起 core-api 时用 `main = test/dev-entry.ts`
 * （`--config` 指向本文件生成的临时配置，或临时改 wrangler.jsonc 的 main 字段）。
 *
 * 为什么需要：services/members.ts 的默认装配是每请求 `createFakeMailProvisioner()`——
 * 每个请求拿到全新内存 fake，批准（createAccount）写进的账户随请求销毁，
 * 后续激活（resetPassword）必 ACCOUNT_NOT_FOUND → 本地完整形态走查第 8 步必失败。
 * 本入口把 fake 提到模块作用域：同一 dev 进程内跨请求共享（单例），
 * 批准 → 激活全链路在内存假实现上端到端可走。
 *
 * 用法（本地走查，等 #195 文档轴落地后由主会话补进 docs/testing.md）：
 *   # 1) 临时把 app/workbench/wrangler.jsonc 的 "main" 改为 "test/dev-entry.ts"
 *   #    （或复制一份 dev.wrangler.jsonc 指向本文件，用 --config 挂）
 *   # 2) cd app/workbench && npx wrangler dev
 *   # 3) 按手机/桌面走查任务书跑完整形态：setup → 邀请 → 填表 → 批准（假开户）→
 *   #    邀请页 claim → 设置邮箱密码（假改密，同一单例账户）→ 登录
 *   # 4) 走查完还原 wrangler.jsonc 的 main（git checkout）
 *
 * 生产装配点零变化：装配引擎（app/installer/src/engine）生成入口仍注入 Stalwart 适配器（#141 组合根）。
 */
import type { ExportedHandler } from '@cloudflare/workers-types';
import type { ExecutionContext } from 'hono';

import { createFakeMailProvisioner } from '@unself/contracts';

import { createApp, type Bindings } from '../src/index';

/** 进程内单例：批准写的账户在后续激活请求里仍可读（这就是 #182 拦路虎的解）。 */
const provisioner = createFakeMailProvisioner();

const app = createApp({
  createMailProvisioner: () => provisioner,
});

export default {
  /**
   * wrangler dev 以 `fetch(request, env, ctx)` 三参调用模块默认导出——
   * 这里把 bindings 按自身 Bindings、ctx 按 Hono 的 ExecutionContext 声明
   * （入口只是 Hono app 的适配层，不用 `as never` 掩盖）；
   * 外层 `satisfies ExportedHandler<Bindings>` 保证这确实是合法 Workers entry 形状，
   * 同时保留具体签名（#193 的 dev-entry.test 要直接三参调用）。
   */
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Bindings>;
