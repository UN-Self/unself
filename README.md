# Unself

> Pluggable, self-hosted team workspace on Cloudflare

## 这是什么

Unself 是**跑在你自己 Cloudflare 账户上的团队工作台**：不是 SaaS、没有中央租户，一次部署对应一个团队。

它解决的问题是「小团队要协作，但不想为用不上的功能付费，也不想把数据交给第三方」——**壳**（登录/成员/审批/通知/审计）是常量，**协作能力是可按需装的模块**（聊天、日历、文档、看板、会议、邮件…）。不要的能力不部署、不花钱；想要而没有的，契约在手自己写，或者装别人写的。

**适合**：2–20 人、能接受数据放在自己云账户里的团队。
**不适合**：要富文本协同文档、百人视频会议、原生 App 后台推送的重度场景（差异明说见 [docs/product.md](docs/product.md)）。

## 跑起来

> 一条命令 `npx @unself/installer`（[issue #242](https://github.com/UN-Self/unself/issues/242)）——**不需要 git、不需要 pnpm**：

```sh
npx @unself/installer
```

浏览器里会打开本地向导：粘 CF API Token → 选域名（没有就用免费的 workers.dev）→ 确认模块（默认 hello）→ 等九步跑完 → 浏览器打开末尾打印的一次性链接设管理员。约 5–10 分钟。

> 贡献者 / 仓库内运行：`git clone` → `pnpm install` → `pnpm -r build` → `node app/installer/dist/unself.mjs`（同一条装配路径）。

失败自救、升级已有实例、备份：[docs/deploy.md](docs/deploy.md)。

## 你要准备的

| 项 | 要求 |
|---|---|
| Cloudflare 账号 | 免费套餐即可（<https://dash.cloudflare.com/sign-up>） |
| Node.js | ≥ 22（`node -v` 自查） |
| pnpm | ≥ 11（`corepack enable` 或 `npm i -g pnpm`） |
| 域名 | 可选：没有就用 workers.dev 免费域名 |
| 费用 | 免费额度够 10 人左右团队；触发条件见 [docs/deploy.md](docs/deploy.md) |

## 装第三方模块

模块可以来自 npm（含私有 registry）、git release 产物、任意 HTTPS tarball，也可以是你本地的一个目录：

```sh
unself module add npm:@acme/unself-todo@1.2.0
unself deploy
```

安装串的四种写法（决策 #58 / #77）：`npm:@acme/unself-todo@1.2.0`、`github:acme/unself-todo#v1.2.0`、`https://…/todo-1.2.0.tgz`、`file:./my-todo`。

**官方模块与第三方同一个东西**：`@unself/hello` 就是普通 npm 包（`npm:@unself/hello@0.1.0`），没有 `official:` 特权来源，安装与卸载路径完全一致。

`module add` 会先解析来源，把「将要装什么」打出来（版本、SRI、声明的权限、数据落点），**未知能力直接拒绝并点名**；解析结果写进 `unself.config.jsonc` 与 `unself.lock`，所以紧接着的 `unself deploy` 不会重复下载。Web 向导第③步也可以点「添加模块」把安装串粘进去，装配前同样展示来源 / 版本 / SRI / 权限 / 落点。

想自己写模块：`unself module pack <目录>` 把模块打成 `.tgz` 并打印 SRI，再发布到 npm / git release / 任意 HTTPS 地址。包格式、字段表、数据落点、发布前自检清单与发布流程：**[docs/modules.md](docs/modules.md)**。

## 卡住了去哪

- 装配器会打印失败三要素（**原因 / 归属 / 修复**），先按「修复」那一行做；
- 常见问题（凭证权限、DNS、幂等重跑）见 [docs/deploy.md](docs/deploy.md)「失败了怎么办」；
- 仍然卡住 → [开 issue](https://github.com/UN-Self/unself/issues)，附上终端里的三要素报错原文。

## 仓库长什么样

两个桶，判据是**谁看得见**：

- **`core/` —— 开发用的依赖库**：`contracts`（协议，内部）、`sdk`（模块作者唯一要装的包，发 npm：`@unself/sdk`）、`ui`（UI 基元与 tokens）、`control-plane`（可复用控制面）、`adapters/{mail-smtp,provisioning/stalwart}`。
- **`app/` —— 开发好的 app，可被装配**（全部发 npm）：
  - **`app/workbench`** = **平台运行体**，一个包两半边：`src/` 后端（core Worker）、`web/` 前端（工作台 SPA）、`migrations/` 数据库迁移。它的产物（`dist/worker.js` + `dist/web` + `migrations`）**随该包发布**。
  - **`app/installer`** = **部署工具**：本地 Web 向导 + `unself` CLI + 九步装配引擎（`src/engine`）。它从 `node_modules/@unself/workbench` 拿产物，不内嵌、也不从源码现构建。
  - **`app/modules/hello`、`app/modules/chat`** = 官方模块，与第三方模块**同一种包**。

## 开发

Node ≥ 22、pnpm ≥ 11。PR 前门禁必须全绿（= CI 同一套 **8 段**，清单在 [docs/testing.md](docs/testing.md)「门禁」）。
测试标准（测行为不测实现；测试不得依赖目录与包名）见 [docs/testing.md](docs/testing.md)；贡献流程与 DCO 见 [CONTRIBUTING.md](CONTRIBUTING.md)（设计变更必须先改设计文档）。

## 文档

[产品定位](docs/product.md) · [架构契约](docs/architecture.md) · [模块契约](docs/modules.md) · [部署](docs/deploy.md) · [决策档案](docs/decisions.md) · [路线图](docs/roadmap.md) · [测试标准](docs/testing.md) · [索引](docs/PRODUCT_SPEC.md)

## 许可证

核心（`app/workbench`、`core/*`、自研模块）为 **AGPL-3.0**（根 [LICENSE](LICENSE)）；EdgeChat 衍生件为 **GPL-3.0**（独立 Worker，见 [NOTICE](NOTICE)）。第三方归属见 NOTICE 与 `third_party/components.yaml`。
