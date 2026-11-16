# Contributing to Unself

谢谢来改 Unself。签署用 DCO（Developer Certificate of Origin），不用 CLA。

## 环境要求

- Node.js ≥ 22
- pnpm ≥ 11
- Git（提交需启用 sign-off）

## DCO 签核规则

所有提交必须带 `Signed-off-by` 行，推荐直接用：

```sh
git commit -s
```

`git commit -s` 会自动在提交信息末尾追加：

```
Signed-off-by: 你的姓名 <你的邮箱>
```

`Signed-off-by` 就是你对这次提交的声明（DCO 1.1）：

- 你在此提交中贡献的代码由你编写，或你有权以本许可证提交；
- 你知晓并同意该贡献按仓库许可证条款分发。

签名的人必须是作者本人：姓名和邮箱跟 `git config user.name` / `user.email` 一致，邮箱要能联系到你。代别人提交时，原作者也加一行自己的 `Signed-off-by`。已经提交的 commit 用 `git commit -s --amend` 补签。

DCO 全文：<https://developercertificate.org/>

## 工作流程

1. 先开 issue 说明意图（功能、缺陷或设计变更），等确认；
2. fork 仓库，创建分支（`feat/xxx`、`fix/xxx` 或 `docs/xxx`）；
3. 修改并提交，每个提交都带 sign-off；
4. 发起 PR，链接对应 issue；
5. 维护者审查。设计相关的改动，先在 docs/ 那两份文件里对齐。

## 设计变更前置

涉及产品形态、模块契约、部署、数据模型或许可证边界的变更，必须**先改**：

- docs/PRODUCT_SPEC.md
- docs/requirements.md

## 本地开发

```bash
pnpm install          # 依赖安装

# 门禁（= CI 同一套，缺一不可）
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

本地不跑真云：`app/workbench` 测试用内存 D1 替身，适配器测试用契约假实现；
联调走装配引擎（`app/installer/src/engine`）真环境。模块联调与启停验证参照七步验收剧本
（docs/PRODUCT_SPEC.md §8 M0 行）。

## 设计变更

这两份文件就是设计本身。评审过了才改代码。只改代码、不改文档的 PR 会被打回。

## 许可证与第三方

- 仓库根目录的 LICENSE 是 AGPL-3.0，覆盖核心、SDK、自研模块和文档。
- 带上 EdgeChat、MiroTalk 代码的模块，按上游自己的许可证单独构建、单独部署，在模块里登记 LICENSE 和 NOTICE，不并进核心。
- 新代码文件头加 `// SPDX-License-Identifier: AGPL-3.0-only`（脚手架会自己带上）。
