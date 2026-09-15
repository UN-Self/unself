# TOP RULES
- 操作决策要留档，保持整个项目的可复现性
- UI 一切有出处：样式出 tokens、基元出 packages/ui、图标出 Lucide，先复用（beUI→shadcn）再手写
- 权限只信服务端会话，前端只是视图
- 一文件一职责，归不清先拆
- 测试测行为不测实现，不会红的测试是负资产
- 问题当场清，不留「下次」
- rebase-only，不 push 主干，不改 docs/（在 PR 里指出），代码文件带 SPDX 头

## 会话循环（worker 会话，每个新会话必读）

一个 issue 一个新会话，做完即退。

1. 认领：当前里程碑编号最小、依赖满足的 issue
2. `git fetch origin && git switch -c m<M>/issue-<N> origin/m<M>/dev`
3. 依据：docs/PRODUCT_SPEC.md、docs/requirements.md；测试标准 docs/testing.md
4. 验证缺一不可：`pnpm -r typecheck && pnpm -r test && pnpm -r build`
5. `git commit -s` 小步提交 → `gh pr create --base m<M>/dev`（中文 + 验收对照）
6. 回报编排会话后即停——不合并、不续领；阻塞同通道报

## 编排规范（主会话）

**派工**：herdr agent（引擎 pi；pane ID ≠ tab ID，`herdr pane list` 查；`herdr agent start` 时传 pane ID）。任务书写 `/tmp/task-<issue>.md`（含硬边界/验收对照）；每个 worker 独立 worktree（分支 `m<M>/issue-<N>`）——worktree 内**禁 git switch、禁 stash**（stash 是全仓共享，会炸）、禁碰主仓库。改动面互不相交才并行；共享文件/紧耦合留主会话。

**五关验收（合并前缺一不可）**：
1. diff/边界复核（越界改动要么退回要么明示批准）
2. 新测试测行为（不是实现细节）
3. **红灯验证**：变异或基线复现——把改动改坏，测试必红（贴证据）
4. 本地三件套全绿（typecheck/test/build）
5. SPDX 头 / `commit -s` / PR 含 `closes #N` + 验收对照表

**合并与收尾**：`gh pr merge --rebase` → 本地 ff `main` 后推送 → 清理 worktree/本地分支/tab。worker 报「完成」不等于交付：先查 worktree/PR 真实状态（防中途静默停机）。

## 三方验证（动手前硬规矩）

官方文档/schema + **真实环境实测** + 代码/测试三者对齐才敢定案——「测试绿≠生产活」已多次实锤。契约/形状类定案必须注明**实测版本**（Stalwart 0.16.17→0.16.20 的 JMAP credentials 形状漂移即因此踩坑）。

## 已知坑（踩过，别再踩）

- **D1 不支持 BEGIN/COMMIT**：清理/批量变更逐条执行，先 COUNT 留档、后复查（见 /tmp 清理记录）
- **已应用的迁移文件禁改**：生产与新装 schema 会分叉；更正走新迁移或注释
- **部署**：wrangler OAuth access token ≈ 2h 过期——部署前先 `wrangler whoami` 触发刷新再导出；`--domain=team.handywote.top` 必带（workers.dev 本机不通）
- **`.deploy/` 生成物是「存在即跳过」**：入口模板（core-worker.js）变更后须先删除旧文件再部署，否则打包报「No matching export」
- **CF Workers 出站 TLS 平台不可用**（决策 #31）：邮件=后台尽力增强；可靠发信排 M2（#135）
- **明文令牌不落库**：一次性令牌只存哈希；权限只信服务端会话
- **UI 纪律**：样式只走 tokens、基元住 packages/ui、动效参数从 tokens 取（禁裸值/禁自创），reduced-motion 降级

## 与用户协作

- 先落决策（issue/评论留档）→ 汇报 → 确认 → 才动手；「先不要动手」= 只诊断不修改
- docs/ 变更：先把修订清单汇报用户过目，再开 PR
- 沟通：一次一件事、结论先行、命令墙；红点贴 F12 Response/日志原文
