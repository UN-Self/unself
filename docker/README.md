# Unself 自托管（Docker）

单容器 workbench（Node 运行体）+ 一个数据卷；PostgreSQL 可选。镜像里装的是发布包
`@unself/workbench@<dist-tag>`，跟裸机 `npx @unself/workbench start` 是同一个 bin、同一条命令。
所有自举（迁移、签名私钥、首启 setup 链接）都在 `workbench start` 里自动完成，不需要手工配密钥或跑 SQL。

## 快速开始

```sh
cp docker/.env.example docker/.env
docker compose -f docker/compose.yml up --build -d
docker compose -f docker/compose.yml logs -f workbench
```

`--build` 首次必须带：镜像由本地 `docker/Dockerfile` 构建（在构建阶段执行 `npm i -g`），
不是从 registry pull。之后改过 `.env` 里的 `UNSELF_VERSION` 才需要再 `--build`。

首启日志里会打印一次性 setup 链接：

```
✅ Unself 核心已就绪 … http://<UNSELF_BASE_URL>/setup?token=…
```

点开它配置管理员（token 用后即焚）。之后访问 `http://<host>:8787`。也可以 `cd docker` 后
省略 `-f docker/compose.yml`。

## 版本：正式包 / 测试包

镜像版本由 `.env` 的 `UNSELF_VERSION` 决定，值是 npm dist-tag 或精确版本号（不是 git ref）：

| 值 | 用途 |
|---|---|
| `latest`（默认） | 正式发布包 |
| `test` | 联调测试包（非 main 分支发的包挂这个 tag） |
| `0.1.2` 之类 | 钉死某个版本 |

跑测试包：

```sh
# docker/.env 里写 UNSELF_VERSION=test
docker compose -f docker/compose.yml up --build -d
```

## 数据库方言

- **sqlite（默认）**：`UNSELF_DB=sqlite:///app/data/core.db`，落 `unself-data` 卷，单容器即可。
- **PostgreSQL**：`docker/.env` 里改成
  `UNSELF_DB=postgres://unself:unself@postgres:5432/unself`，然后

  ```sh
  docker compose -f docker/compose.yml --profile pg up --build -d
  ```

  `postgres` 服务在 `pg` profile 下，默认 `up` 不会起它。workbench 不声明 `depends_on`
  （compose 的依赖不能按 profile 条件挂），PG 没就绪时容器会退出并由 `restart: unless-stopped`
  重试，等 postgres 健康后自动起来。

## 跑未发布的分支（dev profile）

正式镜像只装已发布的包。要跑仓库里还没发布的分支，用源码构建的 `docker/Dockerfile.dev`：

```sh
GITHUB_SHA=$(git rev-parse HEAD) docker compose -f docker/compose.yml --profile dev up --build workbench-dev
```

- 服务名 `workbench-dev`，镜像 `unself-workbench:dev`，端口 `UNSELF_PORT_DEV`（默认 8788），
  数据落独立卷 `unself-data-dev`，不碰正式实例的数据。
- `GITHUB_SHA` 必须给：构建上下文不含 `.git`、slim 基础镜像没有 git，`build-info.json` 的 commit
  只能从构建参数来；缺了会在 `build:worker` 阶段报错退出（拒绝产出无 commit 的产物）。
- 这条路径装全量依赖 + 跑 typecheck + vite build，比正式镜像慢一个数量级，只用于开发联调。

## 头像存储

`UNSELF_FILES` 留空 = 头像能力关闭。两种形态：

- `local:/app/data/avatars` —— 本地目录，必须放在数据卷里才持久。
- `s3://bucket?endpoint=…&region=…&accessKeyId=…&secretAccessKey=…&forcePathStyle=1` ——
  S3 兼容存储（MinIO 等）；`forcePathStyle=1` 让 bucket 走路径风格，自建网关通常必须开。

示例见 `docker/.env.example`。

## 数据卷

- `unself_unself-data` → `/app/data`：sqlite 库、`jwt_private_key.pem`、可选的本地头像目录。
- `unself_unself-data-dev` → `/app/data`（仅 dev profile）：未发布分支联调的数据。
- `unself_pg-data` → `/var/lib/postgresql/data`：PostgreSQL 数据。
（compose 项目名固定为 `unself`，卷名带该前缀。）

删卷等于清空实例（并换签名密钥，存量会话失效）。备份 sqlite 时拷走 `unself-data` 即可。

## 非 root 与宿主目录属主

容器以 `node`（uid/gid 1000）运行，镜像里 `/app/data` 已归它所有。具名卷首次挂载会继承该属主，
默认用法无需处理。若把 `/app/data` 换成宿主目录 bind mount，宿主侧必须先：

```sh
mkdir -p /srv/unself-data && sudo chown 1000:1000 /srv/unself-data
```

否则写库/写私钥会因权限失败退出。

## 反向代理

反代或对外域名访问时**必设** `UNSELF_BASE_URL=https://你的域名`，否则首启深链接按 localhost 拼，
点不开。容器内监听 `0.0.0.0:8787`，宿主端口由 `UNSELF_PORT` 控制（默认 8787）。
