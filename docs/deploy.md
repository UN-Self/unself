# 部署指南

平台和模块是分开装的。平台（core 和 workbench）有两条路。模块的装法见下（不由安装器部署）。两边可以混搭：所有的包都可以根据你的喜好部署 cf，裸机，docker，k8s，随意混搭。

## 平台

### 1. Cloudflare：安装器

安装器只部署 core 和 workbench，默认不部署模块，如果需要可以在对应的 installer 步骤中添加想要安装的模块 npm 包。安装器不调用 wrangler，走自建的 Cloudflare REST 客户端；token 只在这次操作的内存里，不进库、不进日志。

```sh
npx @unself/installer@latest
```

走 Cloudflare 自己的资源：账号、Worker、数据库都在你的 CF 账户里。向导跑完后，用它给出的一次性链接设管理员，然后登录工作台。


### 2. Docker

不走 Cloudflare。一个容器，一个 Node 进程，镜像里没有 wrangler。镜像装的是发布包
`@unself/workbench@<dist-tag>`，跑的是跟裸机 `npx @unself/workbench start` 同一个 bin。

```sh
cp docker/.env.example docker/.env
docker compose -f docker/compose.yml up --build -d
docker compose -f docker/compose.yml logs -f workbench   # 首启的一次性 setup 链接在这里
```

首次要带 `--build`：镜像由本地 Dockerfile 构建（构建阶段 `npm i -g`），不是从 registry pull。
数据在卷 `unself-data` 里。容器起来之后，打开 workbench，设管理员。

要跑仓库里未发布的分支，用源码构建的 dev profile（需要 `GITHUB_SHA`，端口 8788，独立卷）：

```sh
GITHUB_SHA=$(git rev-parse HEAD) docker compose -f docker/compose.yml --profile dev up --build workbench-dev
```

**数据库两种方言**（同一个 compose 文件）：

| 方言 | 怎么起 | 数据在哪 |
|---|---|---|
| sqlite（默认） | `docker compose -f docker/compose.yml up -d` | 卷内 `/app/data/core.db` |
| PostgreSQL | `.env` 里把 `UNSELF_DB` 改成 `postgres://…@postgres:5432/…`，再 `docker compose -f docker/compose.yml --profile pg up -d` | 卷 `pg-data` |

pg 服务挂在 `profile: pg` 下，默认 `up` 不会起它。PG 未就绪时 workbench 连库失败退出、`restart` 策略持续重试，不需要手写等待逻辑。

**环境变量**（偶变量全表与示例值看 `docker/.env.example`）：

| 变量 | 作用 |
|---|---|
| `UNSELF_VERSION` | 装哪个版本：npm dist-tag 或精确版本号，不是 git ref。默认 `latest`；测试包填 `test` |
| `UNSELF_DB` | `sqlite:///app/data/core.db` 或 `postgres://user:pass@host:5432/db` |
| `UNSELF_FILES` | 头像存储。`local:/app/data/avatars` 或 `s3://bucket?endpoint=…&accessKeyId=…&secretAccessKey=…&forcePathStyle=1`（MinIO / 自建 / R2 的 S3 口同一套）。**不设 = 头像能力关闭** |
| `UNSELF_BASE_URL` | 反代或远程访问时必设，否则首启链接指向 localhost |
| `UNSELF_PORT` | 宿主端口，默认 `8787`（容器内固定 8787） |
| `UNSELF_ADDR` / `UNSELF_DATA_DIR` | 监听地址与数据目录，一般不用改 |
| `JWT_PRIVATE_KEY` | 可空。空着就首启自己生成，写进数据卷（0600） |

**非 root 运行**：容器内以 uid 1000 跑，`/app/data` 已归它所有，具名卷开箱即写。用宿主目录 bind mount 时要先在宿主机 `chown 1000:1000`。

**首个管理员**：部署完成输出一次性 setup token 链接；部署者打开并设置管理员用户名+密码（内置身份为默认；OIDC 为折叠可选），核心将该用户登记为管理员，setup 随即封死。不依赖身份源 groups claim，安全边界是“能读到部署输出的人 = 部署者”。

## 模块

模块默认不由安装器部署但是 installer 有专门的步骤可以部署你想部署在 cf 的模块，如果是其他部署方式则参考以下方式。workbench 已经在跑之后，再选下面其中一种。

### 1. 在 workbench 里建成 Cloudflare Worker

打开已部署好的 workbench，到「新建模块」，填 Cloudflare API token。workbench 用这个 token 拉模块包，部署成一个 CF Worker。token 只在这次操作里用，不进库。

这条路要求平台侧能代你调 Cloudflare。平台本身是 Docker 起的也可以，只要这次操作拿得到有权限的 token。

### 2. 自己用 Docker 起模块，再连上 workbench

模块容器你自己构建、自己启动。启动前写上：

| 变量 | 作用 |
|---|---|
| `UNSELF_CORE_URL` | workbench 的可访问地址。模块要能连到它，公网、局域网、Tailscale 都行 |
| `UNSELF_MODULE_KEY` | workbench 里生成的接入码。workbench 只存哈希，明文留在模块这边 |

模块起来后会自己去连 `UNSELF_CORE_URL`。workbench 里看到连接正常，再保存，模块才算装上。

> 另一种情况：模块自己有对外地址（自建反代 / 自有域名）时不用反连。在 workbench 「新增模块 → Cloudflare 部署」里选「我已有地址」，填模块 id 和地址即可登记，壳直接拿它当 iframe src。

`.env` 文件不会被宿主自动读。Docker 要用 compose 的 `env_file`，或在启动命令里把变量传进去。
