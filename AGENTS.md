# TOP RULES
- 操作决策要留档，保持整个项目的可复现性
- UI 一切有出处：样式出 tokens、基元出 packages/ui、图标出 Lucide，先复用（beUI→shadcn）再手写
- 权限只信服务端会话，前端只是视图
- 一文件一职责，归不清先拆
- 测试测行为不测实现，不会红的测试是负资产
- 问题当场清，不留「下次」
- rebase-only，不 push 主干，不改 docs/（在 PR 里指出），代码文件带 SPDX 头

## 会话循环（每个新会话必读）

一个 issue 一个新会话，做完即退。

1. 认领：当前里程碑编号最小、依赖满足的 issue
2. `git fetch origin && git switch -c m1/issue-<N> origin/m1/dev`
3. 依据：docs/PRODUCT_SPEC.md、docs/requirements.md；测试标准 docs/testing.md
4. 验证缺一不可：`pnpm -r typecheck && pnpm -r test && pnpm -r build`
5. `git commit -s` 小步提交 → `gh pr create --base m1/dev`（中文 + 验收对照）
6. 回报 `herdr prompt w6:p1` 后即停——不合并、不续领；阻塞同通道报
