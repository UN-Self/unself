# 部署指南

## 直接跑（复制粘贴，从上到下）

```sh
# 前置：Node.js ≥ 22 和 pnpm ≥ 11（node -v 自查）

git clone https://github.com/UN-Self/unself.git && cd unself
pnpm install

# ① 启动装配器：浏览器授权（推荐，OAuth）或粘贴 CF API Token
node deploy/cloudflare/bin.ts

# ② 按提示选域名（回车 = workers.dev 免费域名）、确认模块（回车 = 默认）
# ③ 等九步跑完，终端末尾打印 setup 链接

# ④ 浏览器打开 setup 链接 → 设管理员用户名密码 → 登录工作台
```

**完成。** 拉人：管理台 → 邀请 → 生成链接发给新人 → 新人填表 → 你批准（秒回，开户+签激活令牌；发信后台尽力，失败不阻塞）→ 新人凭原邀请链接回邀请页自助激活（设邮箱密码）→ 登录。
想要团队邮箱：管理台 → 设置 → 邮件服务（运行时配置，随时改即生效免重部署；填了之后批准邀请会后台尽力开邮箱并发信；发信受 CF Workers 出站限制只是尽力增强，激活必经通道=邀请页三态自助）。

## 失败了怎么办

| 现象 | 修复 |
|---|---|
| `10405`（权限不足） | 凭证缺 zone 级权限：改用 CF 深链接建的 API Token（6 项勾全），再继续 |
| 需要 Total TLS（多级子域证书） | OAuth 覆盖不到（2026-09-17 实测），改用 API Token |
| DNS 报错 | 等 60 秒，重跑同一条命令 |
| 其他任何失败 | 直接重跑 ①——幂等，不会重复建资源 |

看实时日志：`cd deploy/cloudflare && npx wrangler tail unself-core-api`。
仍卡住 → [开 issue](https://github.com/UN-Self/unself/issues)，附上终端里的三要素报错原文。

## 升级已有实例

```sh
cd unself && git pull && node deploy/cloudflare/bin.ts
```

数据原地保留（迁移只增不改）。升级纪律：

- **迁移只加新文件，不改旧文件**：已应用过的迁移不会重跑——`wrangler d1 migrations apply` 按**文件名**记账（`d1_migrations` 表）。要改 schema 就新增 `000N_*.sql`，原地改旧文件对已升级的库不生效（2026-09-15 本地实测：原地改 0001 后重跑报「No migrations to apply!」，旧库仍缺列缺表；补一个新文件即正常应用）。
- **升级前先备份**：core 库 + modules 库（按表导出）+ R2 桶。
- **历史例外（0.1.0 时期）**：`0001_init.sql` / `0002_setup_oidc.sql` 曾被原地修改（0001 补 `users.email/personal_email/status` 与 `invites`/`notification_types`/`notifications` 等表；0002 删 `oidc_flows`）。因此**那时建的旧库**升级到当前版本会缺表缺列：0001/0002 被跳过，只执行新增的 0004/0005，**在 0004 处中断**——`no such table: notification_types: SQLITE_ERROR`（0004 依赖被改的 0001 建的表），`d1_migrations` 停在 0003，库留半迁移态（实测 wrangler 4.129.1）。需重建 D1（或手工补 schema）后重跑装配器；0.1.0 之后建的库（迁移一次到位）不受影响。

## 备份

core 库（用户/权限/审计）+ modules 库按表导出 + R2 桶整体；建议每周一次，放团队自己的存储。

## 花多少钱

Cloudflare 免费套餐足够 10 人左右的团队：Workers 10 万请求/天、D1 5GB、R2 10GB。邮件轴需要一台自己的邮件服务器（如 Stalwart，跑在任意 VPS 上）。

---

## 附：每步在干什么（不用读，卡住了再看）

- **① 凭证**：优先 `wrangler login` 的 OAuth（浏览器授权，零复制粘贴）。**2026-09-17 用 wrangler 4.129.0 实测**（[原始记录](audit/241-oauth覆盖实测-2026-09-17.md)）：OAuth 覆盖 D1 建库/读写/迁移、R2 建桶/列举、KV 建命名空间、Workers 部署、secret 写入、zone 路由增/改/删；**唯一覆盖不到的是 Total TLS（ACM）**，只有多级子域（比 zone 深两级以上）才需要它。需要 Total TLS、偏好 token、或跑 CI 时，用 CF 深链接建 API Token（权限已预填全部 **6** 项：Account 3 + Zone 3），粘回终端即可。token 只在本次进程内存里用，不落盘。
- **② 域名**：workers.dev 免费域名即刻可用；自有域名需 DNS 已托管在 Cloudflare，装配器会自动补代理记录和证书。
- **③ 九步**：建两个数据库（core/modules）→ 跑迁移 → 构建 Shell → 部署 core-api → 部署各模块 → 写模块注册表 → 建 R2 桶 → 生成一次性 setup token → 冒烟检查。幂等：任何时候重跑，只补没完成的部分。
- **④ setup 链接**：一次性，设的第一个账号即管理员。默认内置账号（用户名+密码）；团队有 SSO 可在向导里展开接 OIDC。
- **模块启停**：已部署模块在管理台秒级开关，免重部署；新增/移除模块改 `unself.config.jsonc` 后重跑装配器。
- **装配器源码**：[deploy/cloudflare/README.md](../deploy/cloudflare/README.md)（九步明细、换钥流程、Docker 注记）。
