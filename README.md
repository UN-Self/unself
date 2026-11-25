# Unself

> Pluggable, self-hosted team workspace on Cloudflare

## 这是什么

Unself 是跑在你自己 Cloudflare 账户上的团队工作台。不是 SaaS，没有中央租户，一次部署就是一个团队。

小团队要协作，又不想为用不上的功能付费，也不想把数据交给第三方。壳（登录、成员、审批、通知、审计）是固定的；聊天、日历、文档、看板、会议、邮件这些能力按需要装。不要的不部署、不花钱。想要而还没有的，按契约自己写，或者装别人写的。

**适合**：2–20 人、能接受数据放在自己云账户里的团队。
**不适合**：要富文本协同文档、百人视频会议、原生 App 后台推送的重度场景（差异明说见 [docs/product.md](docs/product.md)）。

## 跑起来

> 一条命令 `npx @unself/installer@latest`——**不需要 git、不需要 pnpm**：

```sh
npx @unself/installer@latest
```

安装器只部署 core 和 workbench，不部署模块。向导跑完后，用一次性链接设管理员。另一条平台路径是 Docker，见 [docs/deploy.md](docs/deploy.md)。

> 贡献者 / 仓库内运行：`git clone` → `pnpm install` → `pnpm -r build` → `node app/installer/dist/installer.mjs`（同一条装配路径）。

失败自救、升级已有实例、备份：[docs/deploy.md](docs/deploy.md)。

## 你要准备的

| 项 | 要求 |
|---|---|
| Cloudflare 账号 | 免费套餐即可（<https://dash.cloudflare.com/sign-up>） |
| Node.js | ≥ 22（`node -v` 自查） |
| pnpm | 普通安装不需要；仅仓库开发需要 ≥ 11 |
| 域名 | 可选：没有就用 workers.dev 免费域名 |
| 费用 | 免费额度够 10 人左右团队；触发条件见 [docs/deploy.md](docs/deploy.md) |

## 装模块

平台起来之后再装。两条路，都不经过安装器：

- 在 workbench 里新建模块，填 Cloudflare API token，部署成 Worker。
- 自己用 Docker 起模块。env 里写接入码和 workbench 的可访问地址，模块连上 core 之后，再按 env 里的声明初始化资源。

资源只有两类，具体变量名还没定。一类是 core 的：Cloudflare 上的库和 S3，或者 core 的其他库。一类是模块自己的库和桶，写在模块自己的 env 里。core 不管理这份 env。

细节见 [docs/deploy.md](docs/deploy.md) 和 [docs/flows.md](docs/flows.md)。模块包格式见 [docs/modules.md](docs/modules.md)。

## 卡住了去哪

- 装配器会打印失败三要素（**原因 / 归属 / 修复**），先按「修复」那一行做；
- 常见问题（凭证权限、DNS、幂等重跑）见 [docs/deploy.md](docs/deploy.md)「失败了怎么办」；
- 仍然卡住 → [开 issue](https://github.com/UN-Self/unself/issues)，附上终端里的三要素报错原文。

## 仓库长什么样

两个桶，判据是**谁看得见**：

- **`core/` —— 开发用的依赖库**：`contracts`（协议，内部）、`sdk`（模块作者唯一要装的包，发 npm：`@unself/sdk`）、`ui`（UI 基元与 tokens）、`control-plane`（可复用控制面）、`adapters/{mail-smtp,provisioning/stalwart}`。
- **`app/` —— 开发好的 app，可被装配**（全部发 npm）：
  - **`app/workbench`** = **平台运行体**，一个包两半边：`src/` 后端（core Worker）、`web/` 前端（工作台 SPA）、`migrations/` 数据库迁移。它的产物（`dist/worker.js` + `dist/web` + `migrations`）**随该包发布**。
  - **`app/installer`** = **部署工具**：只把 core 和 workbench 部署到 Cloudflare。它从 `node_modules/@unself/workbench` 拿产物，不内嵌、也不从源码现构建。
  - **`app/modules/hello`、`app/modules/chat`** = 官方模块，与第三方模块**同一种包**。

## 开发

Node ≥ 22、pnpm ≥ 11。PR 前门禁必须全绿（= CI 同一套 **8 段**，清单在 [docs/testing.md](docs/testing.md)「门禁」）。
测试标准（测行为不测实现；测试不得依赖目录与包名）见 [docs/testing.md](docs/testing.md)；贡献流程与 DCO 见 [CONTRIBUTING.md](CONTRIBUTING.md)（设计变更必须先改设计文档）。

## 文档

[产品定位](docs/product.md) · [架构契约](docs/architecture.md) · [模块契约](docs/modules.md) · [部署](docs/deploy.md) · [路线图](docs/roadmap.md) · [测试标准](docs/testing.md) · [索引](docs/PRODUCT_SPEC.md)

## 许可证

核心（`app/workbench`、`core/*`、自研模块）为 **AGPL-3.0**（根 [LICENSE](LICENSE)）。聊天模块 `app/modules/chat` 源自 EdgeChat，许可证是 **GPL-3.0**（见 [NOTICE](NOTICE)）。第三方归属见 NOTICE 与 `third_party/components.yaml`。
