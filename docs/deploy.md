# 部署指南

## 直接跑（复制粘贴，从上到下）

```sh
# 前置：Node.js ≥ 22 和 pnpm ≥ 11（node -v 自查）

git clone https://github.com/UN-Self/unself.git && cd unself
pnpm install

# ① 启动装配器：打印一个建 token 的链接 → 浏览器点两下 → token 粘回终端
node deploy/cloudflare/bin.ts

# ② 按提示选域名（回车 = workers.dev 免费域名）、确认模块（回车 = 默认）
# ③ 等九步跑完，终端末尾打印 setup 链接

# ④ 浏览器打开 setup 链接 → 设管理员用户名密码 → 登录工作台
```

**完成。** 拉人：管理台 → 邀请 → 生成链接发给新人 → 新人填表 → 你批准 → 新人登录。
想要团队邮箱：管理台 → 设置 → 邮件服务（可选，随时配，填了之后批准邀请会自动开邮箱并发激活邮件）。

## 失败了怎么办

| 现象 | 修复 |
|---|---|
| `10405`（权限不足） | 重跑 ① 重建 token（权限没勾全），再继续 |
| DNS 报错 | 等 60 秒，重跑同一条命令 |
| 其他任何失败 | 直接重跑 ①——幂等，不会重复建资源 |

## 升级已有实例

```sh
cd unself && git pull && node deploy/cloudflare/bin.ts
```

数据原地保留（迁移只增不改）。

## 备份

core 库（用户/权限/审计）+ modules 库按表导出 + R2 桶整体；建议每周一次，放团队自己的存储。

## 花多少钱

Cloudflare 免费套餐足够 10 人左右的团队：Workers 10 万请求/天、D1 5GB、R2 10GB。邮件轴需要一台自己的邮件服务器（如 Stalwart，跑在任意 VPS 上）。

---

## 附：每步在干什么（不用读，卡住了再看）

- **① 深链接**：Cloudflare 要求程序化部署用 API Token（wrangler login 的 OAuth 对 zone 路由授权不足）。链接已预填全部 5 项权限，起个名 → Continue → Create → 复制，粘回终端即可。token 只在本次进程内存里用，不落盘。
- **② 域名**：workers.dev 免费域名即刻可用；自有域名需 DNS 已托管在 Cloudflare，装配器会自动补代理记录和证书。
- **③ 九步**：建两个数据库（core/modules）→ 跑迁移 → 构建 Shell → 部署 core-api → 部署各模块 → 写模块注册表 → 建 R2 桶 → 生成一次性 setup token → 冒烟检查。幂等：任何时候重跑，只补没完成的部分。
- **④ setup 链接**：一次性，设的第一个账号即管理员。默认内置账号（用户名+密码）；团队有 SSO 可在向导里展开接 OIDC。
- **模块启停**：已部署模块在管理台秒级开关，免重部署；新增/移除模块改 `unself.config.jsonc` 后重跑装配器。
- **装配器源码**：[deploy/cloudflare/README.md](../deploy/cloudflare/README.md)（九步明细、换钥流程、Docker 注记）。
