# TOP RULES
- 操作决策要留档，保持整个项目的可复现性

## Unself 会话规约（每个新会话必读）

本仓库采用「一个 issue 一个新会话」模式：会话上下文只装一个 issue，做完即退，防止长上下文劣化质量。

### 工作循环（M0 · 垂直切片）

1. 认领：`gh issue view <N>`——取「M0 · 垂直切片」里程碑里编号最小的未关闭 issue（依赖不满足则顺延）
2. `git fetch origin && git switch -c m0/issue-<N> origin/m0/dev`（永远从最新 origin/m0/dev 切，不用本地旧基线）
3. 实现 + 单元测试；设计依据 docs/PRODUCT_SPEC.md（§5 契约、§6.5 前端约定）与 docs/requirements.md 决策表
4. 验证三件套缺一不可：`pnpm -r typecheck && pnpm -r test && pnpm -r build`
5. `git commit -s`：语义化信息、小步提交
6. `gh pr create --base m0/dev`：中文描述 + 验收对照表
7. 通知主会话后即结束：
   `herdr prompt w6:p1 "PR #X（issue #N）待验收。改动：… 测试：…"`
   遇阻塞同通道：「阻塞：issue #N。原因：… 需要：…」
8. **不要合并 PR，不要继续领下一个 issue**——新 issue 由主会话换新会话执行

### 铁律

- 组件查找序：beUI（beui.dev/r/ 可机读源码）→ shadcn 生态 → 手写
- 样式只取 tokens.css，禁裸值；基元住 packages/ui；图标只用 Lucide（lucide-vue-next），禁 emoji 作图标
- 权限真值只在服务端会话；前端 storage 不做权限判断
- 改任何构建配置必须 `pnpm -r build` 全仓验证（只跑 typecheck/test 不算数）
- 本仓库只允许 rebase 合并；PR 分支必须线性，不产生 merge commit
- 不要 push main / m0/dev；不要改 docs/（发现问题在 PR 里指出，以 docs 为准）
- 全部代码文件带 `// SPDX-License-Identifier: AGPL-3.0-only` 头

## 开发纪律（波次 0 起，M1+ 全程适用）

- 文件单一职责：一个文件只管一个职责域（一路由域/一服务/一组件）；加代码前先回答「这段归谁管」，归不清就先拆再写
- 测试守则：只测业务正路与边缘（契约 + 用户可见行为）；禁脆断言（实现细节/快照/内部调用计数）；纯重构 PR 旧测试必须零改动通过
- 前端视觉与动线改动：CI 三件套之外，验收时用浏览器（agent-browser）走查关键路径；单测不替代肉眼
