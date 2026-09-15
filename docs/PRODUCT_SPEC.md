# 产品设计文档（已拆分 → 索引页）

> 本文档已按「一文件一职责」拆分（2026-09-15，#196）。本页只做索引：原章节 → 新去处，老链接不死。
> 拆分原则：**零语义改写**，句子级内容原样搬运；只改标题层级与交叉引用指向。

## 原 → 新

| 原章节（PRODUCT_SPEC v3） | 新去处 |
|---|---|
| 版本/定位引言、§0 产品定位 | [docs/product.md](product.md)（定位） |
| §1 产品是什么（做完之后的样子） | [docs/product.md](product.md) |
| §2 角色与权限 | [docs/product.md](product.md) |
| §3 需求 → 模块 → 复用/自研 对照表 | [docs/product.md](product.md)（对照表）；需求勾选清单在 [docs/requirements.md](requirements.md) |
| §4 核心端到端链路（模块组合） | [docs/flows.md](flows.md) |
| §5 可插拔架构图、§5.1-§5.8（模块契约/身份 token/路由/数据归属/部署编排/三原语/能力轴/改编纪律） | [docs/architecture.md](architecture.md) |
| §6 代码组织 monorepo | [docs/architecture.md](architecture.md) |
| §6.5 前端约定：主题系统 | [docs/architecture.md](architecture.md) |
| §6.6 M1 产品化决策记录 | [docs/decisions.md](decisions.md)（#35-#40 等编号条目） |
| §7 部署拓扑 | [docs/architecture.md](architecture.md)（部署拓扑节）；操作手册见 [docs/deploy.md](deploy.md) |
| §8 里程碑 | [docs/roadmap.md](roadmap.md) |
| §9 风险与决策点 | [docs/roadmap.md](roadmap.md) |
| §10 Cloudflare 首选部署容量参考 | [docs/roadmap.md](roadmap.md) |
| §11 AI 接入能力调研 | [docs/ai.md](ai.md) |
| §12 与飞书的差异 | [docs/product.md](product.md) |

## 其他去向

- 原 docs/requirements.md §6 已确认架构决策（#1-#34）+ §6.6/散落拍板 → [docs/decisions.md](decisions.md)（统一编号 #1-#45，含日期与来源）
- 原 docs/requirements.md §0 现状与约束（参考部署资产）→ [docs/product.md](product.md)「现状与约束」
- 原 docs/requirements.md §7 第一性原理技术评估 → [docs/architecture.md](architecture.md)
- 原 docs/requirements.md §8 下一步 → [docs/roadmap.md](roadmap.md)「当前状态」
- 部署/升级/备份操作 → [docs/deploy.md](deploy.md)；测试标准 → [docs/testing.md](testing.md)
