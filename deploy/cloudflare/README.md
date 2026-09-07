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

前置：`wrangler login`（或环境变量 `CLOUDFLARE_API_TOKEN`）。脚本自身不持久化
任何凭证；JWT 私钥经 `wrangler secret put` 写入 Worker，不落盘（仅打印指纹备份提示）。

## 产物

所有生成的部署配置与 shell 构建副本落在 `.deploy/cloudflare/`（已 gitignore）：
`core.wrangler.jsonc`、`modules/<id>.wrangler.jsonc`、`assets/`（shell dist + sdk）。
