# 部署指南

> 目标读者：第一次部署 Unself 的团队管理员。全程不需要懂 Cloudflare、OIDC 或邮件协议——照着做就行。约 15 分钟。

## 你需要什么

- 一台装了 Node.js ≥ 22 和 pnpm ≥ 11 的电脑（安装方式见 Node.js 官网）
- 一个 Cloudflare 账户（免费即可，见文末「花多少钱」）
- 可选：一个你自己的域名（DNS 托管在 Cloudflare）——没有就用 workers.dev 免费域名

## 总览

```
① 拿 API Token（30 秒，权限已预选好，只点两下）
② 跑装配器（3 分钟，问答式，一条命令）
③ 打开设置链接，设第一个管理员（2 分钟）
④ 生成邀请链接拉人（之后随时）
```

## 第一步：拿 Cloudflare API Token

```sh
git clone <仓库地址> && cd unself
pnpm install
node deploy/cloudflare/bin.ts
```

第一次运行会检测不到 token，装配器会打印一条**权限已预选好**的链接（不用你自己挑权限）：

```
未检测到 CLOUDFLARE_API_TOKEN。
需要一个 Cloudflare API Token（权限已为你预选，只需点两次）：
  ① 打开 https://dash.cloudflare.com/profile/api-tokens/create?<权限预填参数>
  ② 起名（如 unself-deploy）→ Continue → Create Token → 复制
  ③ 重跑：export CLOUDFLARE_API_TOKEN=<粘贴> && node deploy/cloudflare/bin.ts
```

## 第二步：跑装配器

再次运行后进入三个轻松选择：

```
① 团队入口域名：
   [1] workers.dev 免费域名（推荐起步，随时可换自有域）
   [2] 自有域名（需 DNS 已托管在 Cloudflare）
   → 1
② 启用模块（逗号分隔，回车=全部）：
   [hello] →

──────────── 将装配 ────────────
  域名   unself-<自动生成>.workers.dev
  模块   hello        存储   R2 自动创建
继续？[y/N] → y
```

然后九步自动执行，每步带编号；失败时输出会告诉你**原因、归属、怎么修**：

```
[5/9] 部署模块 hello…… ✗
  原因：10405（Zone 路由权限不足）
  归属：你的 token 缺 Zone 级权限
  修复：用第一屏的深链接重建 token，然后重跑本命令
```

> **任何失败都直接重跑同一条命令**：装配器幂等，重跑只会补齐没完成的部分，不会重复创建资源。

成功后收尾屏：

```
装配完成 ✓
① 打开一次性设置链接：https://xxx.workers.dev/setup?token=…
② 设置第一个管理员（默认：用户名+密码；也可接团队 OIDC）
③ 登录 → 管理台 → 邀请 → 生成链接拉人
④ 想要团队邮箱？设置 → 邮件服务（可选，随时配）
```

## 第三步：首次设置向导

打开收尾屏里的一次性设置链接：

- **默认形态（内置账号）**：设置第一个管理员的用户名和密码——不需要任何外部系统
- **接团队已有的 OIDC**（可选，给有 SSO 的团队）：展开高级项，填 issuer / client_id / client_secret，先「测试连接」再激活

激活后你以管理员身份进入工作台。

## 第四步：拉人（入职闭环）

1. 管理台 → **邀请** → 生成邀请链接（一次性，默认 7 天有效）→ 复制发给新人
2. 新人打开链接填表（用户名+密码，或按实例形态）；提交后进入待审批
3. 你批准（管理台邀请页，手机同页可批）→ 新人即可以自己的账号登录
4. **邮件轴（可选）**：管理台 → 设置 → 邮件服务，填好 mail 段后「测试连接」。
   填了 = 批准时自动开邮箱 + 激活邮件发新人个人邮箱；不填 = 纯身份实例，照常使用

## 失败怎么救

| 现象 | 归属 | 修复 |
|---|---|---|
| `10405`（路由权限不足） | token 缺 Zone 级权限 | 第一步的深链接重建 token |
| DNS 解析未生效 | DNS 传播 | 等 60 秒重跑 |
| `secret not found`（重跑部署） | 已有实例 | 按提示用 wrangler 注入，或继续（幂等补齐） |
| 部署一半中断 | 网络/临时故障 | 直接重跑同一条命令 |

## 升级实例

```sh
git pull
node deploy/cloudflare/bin.ts
```

装配器幂等收敛：新迁移自动应用、Worker 覆盖部署、注册表对齐。**数据原地保留**（升级纪律：迁移文件只增不改，见 PRODUCT_SPEC §5.5）。

## 备份

- `core` 库（用户/权限/审计）+ `modules` 库按表导出 + R2 桶整体——官方提供导出脚本
- 建议：每周导出一次放团队自己的存储

## 花多少钱

Cloudflare 免费套餐足够 10 人左右的团队：Workers 10 万请求/天、D1 5GB、R2 10GB 存储。超出后按量计费——**这正是 Unself 的形态哲学：用多少付多少**。

邮件轴需要一台自己的邮件服务器（如 Stalwart，跑在任意 VPS 上）——这是自托管邮件的固有成本，也是完整实例和最小形态的分界。

## 相关文档

- 设计真相：[docs/PRODUCT_SPEC.md](PRODUCT_SPEC.md)、[docs/requirements.md](requirements.md)
- 装配器细节：[deploy/cloudflare/README.md](../deploy/cloudflare/README.md)
- 开发：根 [README.md](../README.md)
