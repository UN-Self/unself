# Unself

> Pluggable, self-hosted team workspace on Cloudflare

## 这是什么

Unself 是给单个团队的自托管协作平台：不是 SaaS，没有中央租户，一次部署对应一个团队。它交付**壳**（统一登录/成员/审批/通知/审计）、**契约**（manifest + module-sdk + Core API，让模块可插拔）、**装配器**（一条命令把你选的模块物化成 Cloudflare 资源）三样东西；官方模块（EdgeChat 改编、Stalwart 邮件适配等）是改编工艺的示范，第三方照同一套契约接入。每项能力一根轴、按量计费——不要的能力不部署、不花钱。

**demo 暂不提供**（原 demo 地址已下线）；自己部署约 10 分钟，见下。

## 前置条件

| 项 | 要求 |
|---|---|
| Cloudflare 账号 | 免费套餐即可（注册：<https://dash.cloudflare.com/sign-up>）；装配器会引导你创建一个 API Token（权限已预选，浏览器点两下） |
| Node.js | ≥ 22（`node -v` 自查） |
| pnpm | ≥ 11（`corepack enable` 或 `npm i -g pnpm`） |
| 域名 | 可选：没有就用 workers.dev 免费域名（回车即得）；要用自有域名，需 DNS 已托管在 Cloudflare |
| 耗时 | 首次部署约 5–10 分钟（含构建）；重跑幂等收敛更快 |

## 部署（4 步）

```sh
# 1. 拉代码、装依赖
git clone https://github.com/UN-Self/unself.git
cd unself
pnpm install

# 2. 启动装配器（终端打印一个建 API Token 的链接，浏览器点两下，token 粘回终端）
node deploy/cloudflare/bin.ts

# 3. 按提示选域名（回车 = workers.dev 免费域名）、确认模块（回车 = 默认 hello）
#    然后等九步跑完，终端末尾打印一个一次性 setup 链接

# 4. 浏览器打开 setup 链接 → 设第一个管理员用户名密码 → 登录工作台
```

部署细节、失败自救、升级已有实例：[docs/deploy.md](docs/deploy.md)。

## 成功长什么样

- 终端九步全部跑完，末尾打印「装配完成 ✓」与实例地址，以及一行一次性设置链接（形如 `https://<你的域名>/setup?token=...`，仅部署者可见，用后即封死）。
- 浏览器打开该链接：看到 setup 向导 → 设第一个管理员用户名/密码 → 提交后跳到登录页。
- 用刚设的账号登录：进入工作台首页；admin 角色可见「管理台」入口（成员/邀请/审计/设置/模块）。
- 管理台 → 模块：`hello` 已启用；工作台打开 hello 模块页，看到身份行（姓名/邮箱）与计数器，点 [+1] 数字会变。

## 失败了去哪

- 装配器对已知失败会打印三要素（原因 / 归属 / 修复），按「修复」行操作即可：
  - `10405`（token 权限不足）→ 用第一屏的深链接重建 token，重跑装配器；
  - DNS 报错 → 等 60 秒重跑（域名解析传播）；
  - 网络中断 → 检查网络（workers.dev 可能需要代理环境变量）后重跑。
- 其他失败：直接重跑同一条命令——装配器幂等收敛，不会重复建资源。
- Worker 运行时日志：`cd deploy/cloudflare && npx wrangler tail unself-core-api`（实时，需本机网络可达 Cloudflare；日志另存 `~/.config/.wrangler/logs/`）（未实测完整输出，本机网络受限）；更多见 [docs/deploy.md](docs/deploy.md) 的「失败了怎么办」。

## 花多少钱

Cloudflare **免费套餐**足够 10 人左右的团队日常使用：Workers 10 万请求/天、D1 共 5GB、R2 共 10GB。会产生费用的操作：

- 超出免费额度（请求量/存储量/带宽）后按量计费——需先在 Cloudflare 开启付费计划才会扣费，默认不会；
- 使用自有域名走 Cloudflare 的付费功能（如 Argo）才会产生费用，DNS + 证书免费。

邮件能力需要一台自己的邮件服务器（如 Stalwart，跑在任意 VPS 上），费用在 VPS 而非 Cloudflare。

## 模块

| 模块 | 默认实现 | 状态 |
|---|---|---|
| 登录与身份 | 核心内建：内置账号默认 + OIDC 可选 | **已实现**（M0+M1 验收，核心能力非模块） |
| hello（示例模块） | Worker + D1 计数器 | **已实现**（M0 验收：握手/token 验签/数据读写全链路） |
| IM 聊天 | EdgeChat 改编（Worker + DO） | 规划（M2） |
| 日历 | CalDAV/iCalendar 适配器 | 规划 |
| 会议 | Worker + DO 信令，WebRTC P2P | 规划 |
| 文档/看板 | Markdown 文档 + 轻量看板 | 规划 |
| Git | Webhook 适配器 | 规划 |
| 邮件 | Stalwart 瘦适配（JMAP 开户 + 邮箱密码自助） | **已实现**（M1 验收，可选能力） |

未启用的模块不显示、不部署、不创建云资源；已部署模块可在管理台秒级启停。

## 版本状态

**开发中，以 main 为准**（当前唯一 tag：`v0.1.0`，落后于 main；package.json 不跟踪产品版本）。已验收里程碑：M0 垂直切片（部署、setup、hello 全链路、模块启停）、M1 入职闭环与内置身份（实机验收记录 [docs/m1-acceptance.md](docs/m1-acceptance.md)）。

## 开发

- Node.js ≥ 22，pnpm ≥ 11
- 三件套（PR 前必须全绿）：`pnpm -r typecheck && pnpm -r test && pnpm -r build`
- lint 闸门：`pnpm verify:tokens`（主题令牌）；跨版本迁移闸门：`node scripts/check-migrations-upgrade.mjs`
- 测试标准（测行为不测实现、开工前边界自查 8 项）：[docs/testing.md](docs/testing.md)

## 文档（设计真相）

- [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) — 产品设计全量文档
- [docs/requirements.md](docs/requirements.md) — 需求与技术决策
- [docs/deploy.md](docs/deploy.md) — 部署/升级/备份/费用
- [docs/testing.md](docs/testing.md) — 测试标准与边界自查
- [docs/m1-acceptance.md](docs/m1-acceptance.md) — M1 实机验收记录

设计变更必须先改设计文档，再落代码。

## 许可证

- 核心（Shell、Core API、module-sdk、自研模块）：**AGPL-3.0**（根 LICENSE）
- EdgeChat 衍生件：**GPL-3.0**（独立 Worker，见 NOTICE）
- 第三方归属见 NOTICE 与 components.yaml 登记约定（M0 登记后生效；登记文件待 third_party/ 目录建立时落地）

## 参与

[CONTRIBUTING.md](CONTRIBUTING.md)（DCO 签核）· [SECURITY.md](SECURITY.md)（漏洞报告）
