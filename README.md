# Unself

> Pluggable, self-hosted team workspace on Cloudflare

## 这是什么

Unself 是**跑在你自己 Cloudflare 账户上的团队工作台**：不是 SaaS、没有中央租户，一次部署对应一个团队。

它解决的问题是「小团队要协作，但不想为用不上的功能付费，也不想把数据交给第三方」——**壳**（登录/成员/审批/通知/审计）是常量，**协作能力是可按需装的模块**（聊天、日历、文档、看板、会议、邮件…）。不要的能力不部署、不花钱；想要而没有的，契约在手自己写，或者装别人写的。

**适合**：2–20 人、能接受数据放在自己云账户里的团队。
**不适合**：要富文本协同文档、百人视频会议、原生 App 后台推送的重度场景（差异明说见 [docs/product.md](docs/product.md)）。

## 跑起来

> 目标形态是一条命令 `npx @unself/installer`（[issue #242](https://github.com/UN-Self/unself/issues/242) 开发中）。**当前可用路径**（需要 Node ≥ 22 + pnpm ≥ 11）：

```sh
git clone https://github.com/UN-Self/unself.git && cd unself
pnpm install
node deploy/cloudflare/bin.ts
```

按提示授权 → 选域名（没有就用免费的 workers.dev）→ 选模块 → 等九步跑完 → 浏览器打开末尾打印的一次性链接设管理员。约 5–10 分钟。

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

模块可以来自 npm、git、任意 tarball，也可以是你本地的一个目录：

```sh
unself module add npm:@acme/unself-todo@1.2.0
```

（`unself` CLI 随安装器提供，开发中；在 Web 向导里也可以点「添加模块」把安装串粘进去。）

想自己写模块——包格式、字段表、数据落点、`validate` 清单、发布流程：**[docs/modules.md](docs/modules.md)**。

## 卡住了去哪

- 装配器会打印失败三要素（**原因 / 归属 / 修复**），先按「修复」那一行做；
- 常见问题（凭证权限、DNS、幂等重跑）见 [docs/deploy.md](docs/deploy.md)「失败了怎么办」；
- 仍然卡住 → [开 issue](https://github.com/UN-Self/unself/issues)，附上终端里的三要素报错原文。

## 开发

Node ≥ 22、pnpm ≥ 11。PR 前门禁必须全绿（= CI 同一套 5 步，见 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)）。
测试标准（测行为不测实现）见 [docs/testing.md](docs/testing.md)；贡献流程与 DCO 见 [CONTRIBUTING.md](CONTRIBUTING.md)（设计变更必须先改设计文档）。

## 文档

[产品定位](docs/product.md) · [架构契约](docs/architecture.md) · [模块契约](docs/modules.md) · [部署](docs/deploy.md) · [决策档案](docs/decisions.md) · [路线图](docs/roadmap.md) · [测试标准](docs/testing.md) · [索引](docs/PRODUCT_SPEC.md)

## 许可证

核心（Shell、Core API、module-sdk、自研模块）为 **AGPL-3.0**（根 [LICENSE](LICENSE)）；EdgeChat 衍生件为 **GPL-3.0**（独立 Worker，见 [NOTICE](NOTICE)）。第三方归属见 NOTICE 与 `third_party/components.yaml`。
