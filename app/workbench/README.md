# @unself/workbench

一个包、两半边——平台自己那个「装进用户 CF 账户」的 app（#303 合并 `services/core-api` + `apps/shell`）：

| 半边 | 目录 | 是什么 |
|---|---|---|
| 后端 | `src/` | 平台运行期 core Worker 的脚本侧：身份/OIDC、会话、成员与邀请、注册表、通知、审计、module-api 代理（Hono） |
| 前端 | `web/` | 工作台 SPA：登录 / setup / 邀请 / 通知 / 管理台 / 模块 iframe 宿主（Vue 3 + tokens + `@unself/ui`） |
| 数据 | `migrations/` | core 库与平台基建库的迁移 SQL（模块自己的迁移随模块包走） |

装配时两半边合成**一个 Worker**：脚本 = 后端，静态资产 = 前端构建产物。路由与绑定由安装器的装配引擎生成（见 `app/installer/src/engine/assemble.ts`），本仓库内的 `wrangler.jsonc` 只是本地开发参考（占位 database_id，不能直接部署）。

```bash
pnpm --filter @unself/workbench dev        # 前端 vite dev
pnpm --filter @unself/workbench build      # typecheck + vite build → dist/
pnpm --filter @unself/workbench test       # 后端 test/ + 前端与源码同目录的用例（一次 vitest run）
pnpm --filter @unself/workbench typecheck  # 后端 tsc + 前端 vue-tsc（两份 tsconfig）
```

约定：**后端测试放 `test/`，前端测试与源码同目录**（逐文件 `// @vitest-environment jsdom`）；样式只走 tokens（`web/src/tokens.css` 是令牌的壳侧真值，与 `@unself/contracts` 的主题包由 `scripts/verify-tokens.mjs` 与 `web/src/lib/frame-tokens.test.ts` 双向守卫）。
