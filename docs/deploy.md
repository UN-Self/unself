# 部署指南

平台和模块是分开装的。平台（core 和 workbench）有两条路。模块也有两条路，而且不经过安装器。

## 平台

### 1. Cloudflare：安装器

安装器只部署 core 和 workbench，不部署模块。

```sh
npx @unself/installer@latest
```

走 Cloudflare 自己的资源：账号、Worker、数据库都在你的 CF 账户里。向导跑完后，用它给出的一次性链接设管理员，然后登录工作台。


### 2. Docker

不走 Cloudflare。写好环境变量，把 workbench 容器拉起来即可。

```sh
docker compose -f docker/compose.yml up --build
```

常用变量：

| 变量 | 作用 |
|---|---|
| `UNSELF_PORT` | 监听端口，默认 `8787` |
| `UNSELF_BASE_URL` | 反代或远程访问时，workbench 对外的地址。不设的话，别的机器上的模块可能连不进来 |
| `JWT_PRIVATE_KEY` | 可空。空着的话，第一次启动会自己生成，并写进数据卷 |

数据在卷 `unself-data` 里。容器起来之后，打开 workbench，设管理员。

## 模块

模块不由安装器部署。workbench 已经在跑之后，再选下面其中一种。

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

`.env` 文件不会被宿主自动读。Docker 要用 compose 的 `env_file`，或在启动命令里把变量传进去。
