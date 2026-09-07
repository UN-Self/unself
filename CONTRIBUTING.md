# Contributing to Unself

感谢参与 Unself。本项目采用 DCO（Developer Certificate of Origin）签署制，无需 CLA。

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

`Signed-off-by` 的含义是你对本提交的贡献声明（DCO 1.1）：

- 你在此提交中贡献的代码由你编写，或你有权以本许可证提交；
- 你知晓并同意该贡献按仓库许可证条款分发。

签名者必须是作者本人：姓名与邮箱与 `git config user.name` / `user.email` 一致，邮箱需能联系到你。代提交他人代码时，原作者也应加自己的 `Signed-off-by` 行。已提交的 commit 可用 `git commit -s --amend` 补签。

DCO 全文：<https://developercertificate.org/>

## 工作流程

1. 先开 issue 说明意图（功能、缺陷或设计变更），等确认；
2. fork 仓库，创建分支（`feat/xxx`、`fix/xxx` 或 `docs/xxx`）；
3. 修改并提交，每个提交都带 sign-off；
4. 发起 PR，链接对应 issue；
5. 维护者审查；设计相关改动需先在 docs/ 两文件达成一致。

## 设计变更前置

涉及产品形态、模块契约、部署、数据模型或许可证边界的变更，必须**先改**：

- docs/PRODUCT_SPEC.md
- docs/requirements.md

两份文件是设计真相，评审通过后才允许进入代码；只改代码不改文档的 PR 会被打回。

## 本地开发

本地开发环境（依赖安装、core 与 modules 两库初始化、hello 模块联调、启停验证等）随 **M0 交付补全**，届时本节约会更新为可执行的步骤。

## 许可证与第三方

- 仓库根 LICENSE = AGPL-3.0，覆盖核心、SDK、自研模块与文档；
- 包含或修改 EdgeChat、MiroTalk 代码的模块按各自上游许可证独立构建、独立部署，模块级 LICENSE 与 NOTICE 登记，不并入核心；
- 新代码文件头加 `// SPDX-License-Identifier: AGPL-3.0-only`（脚手架自动带上）。
