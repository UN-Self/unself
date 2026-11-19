# 协作

- 没有明确的改文件指令，只读，不改
- 一次说一件事。先给结论。命令单独成块
- rebase-only，不 push `main`
- 代码文件带 SPDX 头
- 验收、审计、走查留在对应 issue 或 PR，不写进 `docs/`

## 不要做

- 用户没有主动要求设计测试，不要写测试，也不要补测试文件。标准见 [docs/testing.md](docs/testing.md)
- 不要另开决策档案。契约改原文。过程留在 issue 或 PR

## 文档

以当前正文为唯一真相源（除非明确要求更改契约）：

- 产品 [docs/product.md](docs/product.md)
- 需求 [docs/requirements.md](docs/requirements.md)
- 架构 [docs/architecture.md](docs/architecture.md)
- 链路 [docs/flows.md](docs/flows.md)
- 模块 [docs/modules.md](docs/modules.md)
- 部署 [docs/deploy.md](docs/deploy.md)
- 测试 [docs/testing.md](docs/testing.md)
- 路线图 [docs/roadmap.md](docs/roadmap.md)

仓库两桶：`core/` 是库，`app/` 是可装配的成品。主干是 `main`。

## 改代码时

- UI：样式只走 tokens，基元先复用再手写，图标用 Lucide。动效参数从 tokens 取，reduced-motion 要降级
- 权限只信服务端会话，前端只是视图
- 一文件一职责
- 问题当场清，不留「下次」
- 契约、接口形状要定案时，官方文档、真实环境、代码三边对齐，并写上实测版本。测试绿不等于生产是活的

## 已知坑

- D1 没有 `BEGIN`/`COMMIT`，迁移逐条执行。已经应用过的迁移文件不能改，按文件名记账。多个模块共用一个库时，各自用独立记账表，否则同名迁移会被跳过
- `cloudflare:sockets` 的 `connect(address, options)`：`secureTransport` 在第二个参数里，默认 `off`。写进 address 会被丢掉
- 安装器不调用 wrangler。OAuth scope 清单推不出真实权限，权限结论只能实测
- CI 门禁是 build、typecheck、test。清单见 [docs/testing.md](docs/testing.md)
- PR 目标不是默认分支时，`closes #N` 不会自动关 issue，要手动 `gh issue close` 并写明合并点
