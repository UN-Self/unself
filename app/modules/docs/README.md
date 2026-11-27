# @unself/docs

云笺模块（issue #358）：多人文档，五个业务接口 + 生命周期接口，三种跑法同一个包。

## 当前权限状态（临时）

文档共享所需的成员管理接口与前端共享入口尚未实现（#358 只落地了 owner/editor/viewer 裁决与
五个文档端点，见 `src/routes.ts`）。在此之前的临时口径：

- 持有 docs 模块 token 的实例成员可**只读**打开全部未删除文档；列表同样返回全部未删除文档，
  **列表项含完整正文与 `ownerId`**——等于可翻页读遍全实例文档，不只是「按链接能打开」。
- 编辑、保存仅限 owner 与成员表内的 editor；删除仅限 owner；成员表脏值仍按非成员处理。
- 未登录仍 401；不存在或已软删仍 404；成员表已有的真实角色（editor/viewer）照常生效。

这是临时偏离，不是正式契约。恢复步骤以下面这份清单为准（源码注释均指向这里）：

1. `src/auth/policy.ts`：把 `OPEN_ACCESS_ROLE` 改回 `null`。`resolveRole` 的兜底会随之回到「无成员行 → 非成员」，无需删代码。
2. `src/repo/documents.ts`：把 `listDocuments` 的新 SQL 与 5 个绑定整条换回函数体内注释的原 SQL
   （原绑定：`userId, userId, userId, limit + 1, offset`）。
3. 还原三处测试断言：`test/app.test.ts`（非成员 200/403 → 404）、
   `test/docs-repo.test.ts`（全员可见 → 我的 + 共享给我的）、`test/policy.test.ts`（缺行 → 期望随常量变化）。
4. 重新 `pnpm run build` 并 `pnpm pack`：`dist/` 与已打出的 tarball 都落后于源码，联调前必须重做。

## 目录

```
src/index.ts     模块本体（Hono app）：CF worker 入口，装配引擎直接 bundle 它
src/node.ts      node 入口：建库 → 迁移 → 装配 → 三行调用 @unself/sdk/host 反连
src/life.ts      生命周期端点（export / purge），业务体在 life-data.ts
migrations/      SQLite 迁移（独立账本 unself_migrations_docs，逐条执行）
frontend/        前端源码，构建产物进包内 assets/（static.ts 服务）
.env.example     反连 + JWKS env 样例
Dockerfile / compose.yml  docker 跑法（镜像 = 包的薄壳，数据落卷 /app/data）
```

## env（反连两项 + 公钥 + 可选路径）

| 变量 | 必填 | 说明 |
|---|---|---|
| `UNSELF_CORE_URL` | 反连时 | core 可达地址，模块能连到即可 |
| `UNSELF_MODULE_KEY` | 反连时 | 管理台「生成接入码」给出的凭据明文；core 只存哈希 |
| `CORE_JWKS_JSON` | 是 | core 签名公钥（JWKS），部署期注入：`GET <core>/.well-known/jwks.json` 响应体原文。缺它 = 带鉴权的接口一律 503；坏值 = 进程起不来 |
| `DOCS_DB_PATH` | 否 | SQLite 路径，默认 `data/docs.sqlite`（相对包根；compose 卷正好接住） |
| `UNSELF_MODULE_ADDR` | 否 | 本地监听地址，默认 `127.0.0.1:8790`（sdk/host 认领；compose 跑法已显式覆盖为 `0.0.0.0:8791`，否则端口映射不通） |

宿主只认进程 env、不读 .env 文件；文件加载归调用方（dev 用 `--env-file-if-exists`，
docker 用 compose `env_file`）。缺 `UNSELF_CORE_URL` 或 `UNSELF_MODULE_KEY` = 只跑本地
HTTP 不拨号。

## 三种跑法

### ① 仓库内开发（本地 dev）

```bash
cd app/modules/docs
cp .env.example .env          # 填反连两项 + CORE_JWKS_JSON
pnpm run dev
```

### ② 本地 npm 包（发布态验证）

```bash
pnpm pack                     # 出 unself-docs-<version>.tgz（prepack 自动构建）
npm install <path>/unself-docs-<version>.tgz
CORE_JWKS_JSON=… UNSELF_CORE_URL=… UNSELF_MODULE_KEY=… npx unself-docs
```

### ③ docker compose

```bash
pnpm pack                     # 构建上下文要有 tarball（见 Dockerfile）
cp .env.example .env          # 填好
docker compose up --build -d
```

数据在具名卷 `docs-data`（容器内 `/app/data`，非 root uid 1000 所有）。compose 已显式
设 `DOCS_DB_PATH=/app/data/docs.sqlite`——全局包真实落点是
`/usr/local/lib/node_modules`，默认值（相对包根）会写进容器层而非卷。

## 部署纪律（D6 定案）

`/life/export`、`/life/purge` 没有额外管理鉴权：任何持有效模块 token 的人可全库导出
或清除。**模块 token 等同模块管理凭据**，不要把 8791 暴露给不可信网络——公网部署走
反代并加访问控制。

## 接入动线（对齐管理台）

1. 壳 `/admin/modules` → 新增模块 → 反连接入 → 模块 id `docs` → 生成接入码
2. `UNSELF_MODULE_KEY=<明文>` 写进 `.env`（只展示一次；丢了就重新生成）
3. `CORE_JWKS_JSON` 取 `GET <core>/.well-known/jwks.json` 响应体原文；换钥 = 重新注入，旧 token 立即失效
4. 起 docs（任一跑法）→ 工作台「测试连接」绿 → 保存
5. 验证数据面：`GET <core>/m/docs/api/health` → `{"ok":true}`
