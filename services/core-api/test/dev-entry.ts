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
 *   # 1) 临时把 services/core-api/wrangler.jsonc 的 "main" 改为 "test/dev-entry.ts"
 *   #    （或复制一份 dev.wrangler.jsonc 指向本文件，用 --config 挂）
 *   # 2) cd services/core-api && npx wrangler dev
 *   # 3) 按手机/桌面走查任务书跑完整形态：setup → 邀请 → 填表 → 批准（假开户）→
 *   #    邀请页 claim → 设置邮箱密码（假改密，同一单例账户）→ 登录
 *   # 4) 走查完还原 wrangler.jsonc 的 main（git checkout）
 *
 * 生产装配点零变化：deploy/cloudflare 生成入口仍注入 Stalwart 适配器（#141 组合根）。
 */
import { createFakeMailProvisioner } from '@unself/contracts';

import { createApp } from '../src/index';

/** 进程内单例：批准写的账户在后续激活请求里仍可读（这就是 #182 拦路虎的解）。 */
const provisioner = createFakeMailProvisioner();

const app = createApp({
  createMailProvisioner: () => provisioner,
});

export default {
  fetch: (request: Request, env: unknown, ctx: unknown) =>
    app.fetch(request, env as never, ctx as never),
};
