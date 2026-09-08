# deploy/cloudflare

Unself 的 Cloudflare 装配引擎（M0 #14，PRODUCT_SPEC §5.5）：幂等九步脚本，
读仓库根 `unself.config.jsonc`，把 core-api（shell + Core API）与选中模块装配进
部署者的 Cloudflare 账户。装配只在部署时执行一次，实例运行时不持有任何 CF 凭证。

## 九步

| # | 步骤 | 实现 |
|---|------|------|
| ① | 确保 core/modules 两个 D1 存在 | `d1 list` 查漏 → `d1 create`（幂等：已存在即跳过） |
| ② | 跑核心迁移与选中模块迁移 | `wrangler d1 migrations apply`（core 与各模块自管 migrations_dir；表前缀版本化） |
| ③ | 构建上传 Shell Worker | `vite build`（apps/shell）→ 生成 `.deploy/cloudflare/` 装配产物 → `wrangler deploy` |
| ④ | 每个选中模块构建、上传、绑 `/m/<id>/*` 路由与存储绑定 | esbuild 打包模块 Worker + module-sdk 资产 → `wrangler deploy`（route = `<domain>/m/<id>/*`） |
| ⑤ | 注册表写入 | `wrangler d1 execute` upsert `module_registry`（选中 enabled=1，未选 enabled=0/not_deployed；manifest 快照随注册刷新） |
| ⑥ | 建 R2 桶或接收外部 S3 参数 | `r2 bucket list` 查漏 → `r2 bucket create unself-storage`（provider=s3 时校验外部参数即可） |
| ⑦ | OIDC 不进配置文件 | 无操作——部署后在 setup 向导填写，存 core 库 instance_config（已知缺口见 spec） |
| ⑧ | 生成一次性 setup token | 调 `POST /api/admin/setup-token`，打印一次性激活链接在部署输出末尾（409 = 已封死） |
| ⑨ | 冒烟检查 | `GET /api/health` + 各选中模块 `GET /m/<id>/api/health` |

## 可重跑收敛

脚本幂等：D1/R2 只在缺失时创建；迁移按版本表只补未跑的；Workers deploy 天然
覆盖式；registry upsert 收敛到同一终态；setup token 在 setup 已完成后拿 409 并
提示「实例已配置」。**空 CF 账号连跑两次结果一致**（#14 验收）。

## 用法

```sh
pnpm install                      # 仓库根
pnpm --filter @unself/deploy-cloudflare exec deploy-cloudflare
# 或：node deploy/cloudflare/bin.ts（仓库根执行）
```

前置：API Token（主路径）。权限清单：

| 范围 | 权限 |
|------|------|
| Account（目标账户） | Workers Scripts Edit、D1 Edit、R2 Edit |
| Zone（`config.domain` 所属 zone，如 demo.handywote.top ∈ handywote.top） | Workers Routes Edit、DNS Edit、SSL and Certificates Edit |

设置方式：`export CLOUDFLARE_API_TOKEN=...`——不落盘，脚本不持久化凭证；JWT 私钥经
`wrangler secret put` 写入 Worker，不落盘（仅打印指纹备份提示）。

`wrangler login` 的 OAuth 凭证对 zone 路由（zones/.../workers/routes）授权不足，
PUT zone 路由报 10405——zone 路由必须用 API Token。

## 路由形态（§5.3 zone 路径路由，真机实证）

core 与模块全部 zone 路径路由：core = `<domain>/*`，模块 = `<domain>/m/<id>/*`（最长前缀胜出）。
不用 Custom Domain：同一 host 上 Custom Domain 优先于路径路由，core 挂 Custom Domain 会吞掉
模块路由（#59）；旧 Custom Domain 由脚本幂等解绑。zone 路由要求 host 有代理 DNS 记录：
部署脚本在 core 部署后幂等补建一条代理 A 记录（192.0.2.1 占位），zone 逐级上溯探测
（无需 config zone 字段）。多级子域不在 Universal SSL 覆盖内，脚本自动开启 Total TLS
逐个签发证书（签发秒级延迟，冒烟前已触发）。

## 模块验签公钥（CORE_JWKS_JSON，部署期注入）

模块与 core 同 zone 时，模块 Worker 运行时跨 Worker 拉 core 的 `/.well-known/jwks.json`
会被 CF 同 zone 禁令拦截 → 恒 401（#71 根因①）。B 方案：部署期把 core 公钥以
`vars.CORE_JWKS_JSON` 注入各模块——内容是 `{ keys: [ { kty:'EC', crv:'P-256', x, y, kid,
use:'sig', alg:'ES256' } ] }`（与 core `GET /.well-known/jwks.json` 响应体同形状），
模块本地验签，零运行时网络。

取钥两级（均在步骤④模块循环前）：

| 情形 | 取钥方式 |
|------|----------|
| 首部署（本运行刚生成 JWT_PRIVATE_KEY） | 直接用内存里的新公钥（不抓公网，部署器对刚 deploy 的域名抓取会因 DNS/路由未就绪失败） |
| 已有 secret（重跑） | 部署器在公网 `GET <baseUrl>/.well-known/jwks.json`（无 CF 同 zone 禁令）；失败即硬报错，提示 DNS/路由可能尚未就绪，可重跑部署（幂等） |

## 换钥流程（轮换 JWT 签名密钥）

1. `wrangler secret put JWT_PRIVATE_KEY --name unself-core-api`（新 PKCS8 PEM）
   ——core 的签名密钥由 secret 派生，替换后立即生效（secret put 会触发重新部署）；
2. 重跑部署脚本：核心迁移/模块部署幂等收敛，步骤④会重新抓取 `/.well-known/jwks.json`
   （现在已是新公钥）并把新 JWKS 注入各模块 `vars.CORE_JWKS_JSON`；
3. 旧 token 由新 kid 拒绝，系统自然失效——存量会话需重新登录。

## Docker 等价注记

`docker/` 目录目前为空壳，本次改动只在 CF 装配器（`deploy/cloudflare`）落地。
容器化部署的等价做法：同一环境变量 `CORE_JWKS_JSON` 写入 compose 的模块服务
environment（值由生成脚本在启动时从 core 侧导出），模块行为与 CF 一致——本地验签、
零运行时网络取钥。待 docker/ 落地时按此注记实现。

## 产物

所有生成的部署配置与 shell 构建副本落在 `.deploy/cloudflare/`（已 gitignore）：
`core.wrangler.jsonc`、`modules/<id>.wrangler.jsonc`、`assets/`（shell dist + sdk）。
