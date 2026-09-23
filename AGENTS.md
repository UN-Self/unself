# TOP RULES
- 操作决策要留档，保持整个项目的可复现性
- UI 一切有出处：样式出 tokens、基元出 core/ui、图标出 Lucide，先复用（beUI→shadcn）再手写
- 权限只信服务端会话，前端只是视图
- 一文件一职责，归不清先拆
- 测试测行为不测实现，不会红的测试是负资产
- 问题当场清，不留「下次」
- rebase-only，不 push 主干，docs/ 修订先给用户过目再开 PR，代码文件带 SPDX 头
- **验收记录只存对应 issue/PR，禁止落成文档**（含审计/走查原始记录；docs/ 下不得有验收记录类文件）

## 文档地图（依据去哪找）

产品 docs/product.md · 需求清单 docs/requirements.md · 架构契约 docs/architecture.md · 链路 docs/flows.md · 决策 docs/decisions.md（只增不改）· 路线图 docs/roadmap.md · 部署 docs/deploy.md · 测试 docs/testing.md · AI 调研 docs/ai.md · 索引 docs/PRODUCT_SPEC.md；验收/审计记录不设文档，只存对应 issue 与 PR（决策 #94）。

仓库两桶：`core/` = 依赖库；`app/` = 可装配的成品（全部发 npm；判据与改名表见决策 #83）。

## 会话循环（worker 会话，每个新会话必读）

一个 issue 一个新会话，做完即退。

1. 认领：当前里程碑编号最小、依赖满足的 issue
2. `git fetch origin && git switch -c m<M>/issue-<N> origin/m<M>/dev`
3. 依据：docs/ 内按上表找；测试标准 docs/testing.md
4. 验证缺一不可：**八段门禁**（唯一清单在 docs/testing.md「门禁」；CI 与本地同一套）
5. `git commit -s` 小步提交 → `gh pr create --base m<M>/dev`（中文 + 验收对照）
6. 回报编排会话后即停——不合并、不续领；阻塞同通道报

## 编排规范（主会话）

**派工**：herdr agent（引擎 pi；pane ID ≠ tab ID，`herdr pane list` 查；`herdr agent start` 时传 pane ID）。任务书写 `/tmp/task-<issue>.md`（含硬边界/验收对照）；每个 worker 独立 worktree（分支 `m<M>/issue-<N>`）——worktree 内**禁 git switch、禁 stash**（stash 是全仓共享，会炸）、禁碰主仓库。改动面互不相交才并行；共享文件/紧耦合留主会话。

**五关验收（合并前缺一不可；走查在合并前做，不攒到最后——机制④）**：
1. diff/边界复核（越界改动要么退回要么明示批准）
2. 新测试测行为（不是实现细节；标准见 docs/testing.md）；**部署/UI 类改动必须附真浏览器渲染取证**（#279：全绿仍白屏；口径见 docs/testing.md「职责边界」）
3. **红灯验证**：变异或基线复现——把改动改坏，测试必红（贴证据）
4. 本地门禁全绿（= CI 同一套，缺一不可；唯一清单见 docs/testing.md「门禁」）
5. SPDX 头 / `commit -s` / PR 含 `closes #N` + 验收对照表

**合并与收尾**：`gh pr merge --rebase` → 本地 ff `main` 后推送 → 清理 worktree/本地分支/tab。worker 报「完成」不等于交付：先查 worktree/PR 真实状态（防中途静默停机）。里程碑收官条件见 docs/roadmap.md「收官定义」。

## 三方验证（动手前硬规矩）

官方文档/schema + **真实环境实测** + 代码/测试三者对齐才敢定案——「测试绿≠生产活」已多次实锤。契约/形状类定案必须注明**实测版本**（Stalwart 0.16.17→0.16.20 的 JMAP credentials 形状漂移即因此踩坑）。

## 已知坑索引（一行一条，细节见指向处）

- D1 不支持 BEGIN/COMMIT → 逐条执行、先 COUNT 后复查
- 已应用迁移文件禁改（升级链按文件名记账）→ 症状与自救见 docs/deploy.md「升级已有实例」
- 未封箱窗口=接管面：setup token 签发权只在部署者手里（#165）
- 部署：wrangler token ≈2h 过期先 `whoami` 刷新；`--domain=` 必带 → docs/deploy.md
- Worker 名变更（0.2.0 起 `<实例名>-workbench`，旧名 `-core-api`）：删旧建新，D1/R2/KV 名与数据不动 → docs/deploy.md「升级已有实例」
- CF Workers 出站 TLS 平台不可用（决策 #31）：邮件=后台尽力增强
- 明文令牌不落库；权限只信服务端会话
- UI 纪律：样式只走 tokens、动效参数从 tokens 取，reduced-motion 降级 → docs/architecture.md
- 多模块共用一个 DB 时迁移按**文件名**记账 → 每模块必须用独立记账表（`migrations_table`），否则同名迁移被静默跳过 → docs/modules.md
- wrangler 版本漂移会改变结论：OAuth 能否绑 zone 路由在 4.129.0 已可（旧版报 10405）；契约/形状类定案必须注明 wrangler 版本 → issue #241（实测记录已迁入）
- wrangler 完整安装 213MB，其中 workerd 二进制 147MB 无法剥离（miniflare 启动即 require）→ 装配器不依赖 wrangler（决策 #65）
- 从 OAuth scope 清单推断权限不可靠（「无 R2 scope」实测仍能建桶）→ 权限类结论只能实测 → issue #241（实测记录已迁入）
- **CI 门禁不是「三件套」**：含 `verify-workflows` / `verify-paths`（结构闸门）/ `pnpm verify:tokens` / `check-migrations-upgrade` → 只跑三件套会「本地全绿、CI 红」（#258 实锤；清单见 docs/testing.md）
- **worktree 基座读本地引用**：合并远端后先 `git merge --ff-only origin/m2/dev` 再 `herdr worktree create --base`，否则新 worktree 基于陈旧树（#248 实测：差点让 worker 在缺 #243~#247 的树上开工）
- **PR 目标非默认分支时 `closes #N` 不会自动关 issue**：合进 `m2/dev` 后要手动 `gh issue close` 并写明合并点（#242/#245/#246/#247 实测滞留）

## 与用户协作

- 先落决策（issue/评论留档）→ 汇报 → 确认 → 才动手；「先不要动手」= 只诊断不修改
- docs/ 变更：先把修订清单汇报用户过目，再开 PR
- 审计与实测证据进 issue/PR（别留本地、别落 docs/、也别写成流程剧本）——结论 + 证据，够别人自己复现即可
- 沟通：一次一件事、结论先行、命令墙；红点贴 F12 Response/日志原文
