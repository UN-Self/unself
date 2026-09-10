# Unself

> Pluggable, self-hosted team workspace on Cloudflare

## 定位

给单个团队的自托管协作平台：不是 SaaS，没有中央租户。**Unself 交付的是壳、契约、装配器三样东西**——壳统一登录/成员/审批/通知/审计与工作台；契约（manifest + module-sdk + Core API + 注册表启停）让模块可插拔可自研；装配器把你选中的模块物化成 Cloudflare 资源。**模块是载荷不是产品**：官方模块（EdgeChat 改编、Stalwart 适配等）是改编工艺的示范，第三方照同一套契约写适配层或接入自己的 CF 服务。每项能力一根轴、按量计费——不要的能力不部署、不花钱。

## 差异化

1. **模块 = 独立 Worker，按 iframe 契约装载**：壳与模块之间只有 manifest、module-sdk、Core API 三条通道；模块内部实现壳概不知情，独立构建、独立部署、独立启停，第三方模块只需能起一个 HTTPS 站点。
2. **一实例一团队**：每次部署对应一个团队，无租户切换，无 Unself 中央控制面。
3. **数据两库 + 表前缀隔离**：`core`（用户/角色/注册表/审计）与 `modules`（全部模块业务数据，表前缀 = 模块 id）两个 D1；模块只经 SDK 存储接口访问，禁止跨模块查询与外键。
4. **能力自选，按量计费**：对比飞书式全家桶（为用不上的功能买单）与纯聊天工具（功能太窄），Unself 在 Cloudflare 按量计费的地基上自选组合——身份、邮件、聊天、日历各自独立开合。

## 架构（极简）

```text
team.example.com
├─ /              → Shell + Core API（统一壳、模块注册、权限）
└─ /m/<模块id>/*  → 各模块 Worker（如 /m/chat/*），未启用不部署
```

Workers Routes 按路径绑定；Docker 用 openresty 按 location 分发，两者等价。

## 模块

| 模块 | 默认实现 | 状态 |
|---|---|---|
| 登录与身份 | 核心内建：内置账号默认 + OIDC 可选 | 必选核心能力，非模块 |
| IM | EdgeChat（Worker + DO） | 可选 |
| 日历 | CalDAV/iCalendar 适配器 | 可选 |
| 会议 | Worker + DO 信令，WebRTC P2P 媒体 | 可选 |
| 文档/看板 | Markdown 文档 + 轻量看板 | 可选 |
| Git | Webhook 适配器 | 可选 |

未启用的模块不显示、不部署、不创建云资源。

## 状态

**最小可用（v0.1.0）**。M0 垂直切片交付：Cloudflare 实例可部署、首个管理员经 OIDC 登录、hello 模块全链路（网页桥接/握手/token 验签/数据读写）、模块运行时启停、移除模块重部署后路由消失。实机验收通过（https://unself.handywote.top）。后续迭代见 PRODUCT_SPEC/requirements 与 issues。

## 开发

- Node.js ≥ 22
- pnpm ≥ 11

## 文档（设计真相）

- [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) — 产品设计全量文档
- [docs/requirements.md](docs/requirements.md) — 需求与技术决策

设计变更必须先改这两份文件，再落代码。

## 许可证

- 核心（Shell、Core API、module-sdk、自研模块）：**AGPL-3.0**（根 LICENSE）
- EdgeChat 衍生件：**GPL-3.0**（独立 Worker，见 NOTICE）
- 第三方归属见 NOTICE 与 third_party/components.yaml（M0 登记后生效）

## 参与

[CONTRIBUTING.md](CONTRIBUTING.md)（DCO 签核）· [SECURITY.md](SECURITY.md)（漏洞报告）
