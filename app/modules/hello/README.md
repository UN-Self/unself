# @unself/module-hello

开发示例（issue #349 决策 #110/#111）：演示 unself 模块的「样子」——业务 + 三行接入，
三种跑法同一个包。

## 目录

```
src/index.ts    模块本体（Hono app）：CF worker 入口，装配引擎直接 bundle 它
src/main.ts     node 入口：三行调用 @unself/sdk/host，通用机器全在 sdk
scripts/build.mjs  发布产物构建：main.ts 全量 bundle 成 dist/main.js（bin，零运行时依赖）
.env.example    反连 env 样例
Dockerfile / compose.yml  docker 跑法（镜像 = 包的薄壳）
```

## env（决策 #108 两项 + 可选监听地址）

| 变量 | 必填 | 说明 |
|---|---|---|
| `UNSELF_CORE_URL` | 反连时 | core 可达地址（域名 / 局域网 IP / Tailscale IP，模块能连到即可） |
| `UNSELF_MODULE_KEY` | 反连时 | 管理台「生成接入码」给出的凭据明文；core 只存哈希 |
| `UNSELF_MODULE_ADDR` | 否 | 本地 HTTP 监听地址，默认 `127.0.0.1:8790` |

宿主只认进程 env、不读 .env 文件；文件加载归调用方（下面 ① 用 `tsx --env-file`，
③ 用 compose `env_file`）。缺 `UNSELF_CORE_URL` 或 `UNSELF_MODULE_KEY` = 只跑本地
HTTP 不拨号。

## 三种跑法

### ① 仓库内开发（本地 dev）

```bash
cd app/modules/hello
cp .env.example .env          # 填 UNSELF_CORE_URL / UNSELF_MODULE_KEY
pnpm run dev                  # tsx 读当前目录 .env，起服务 + 反连
```

### ② 本地 npm 包（发布态验证）

```bash
pnpm pack                     # 出 unself-hello-0.1.0.tgz（prepack 自动构建）
mkdir /tmp/try && cd /tmp/try
npm install <path>/unself-hello-0.1.0.tgz
UNSELF_CORE_URL=… UNSELF_MODULE_KEY=… npx unself-hello
```

### ③ docker compose

```bash
pnpm pack                     # 构建上下文要有 tarball（见 Dockerfile）
docker compose up             # env_file 挂 .env，容器内跑同一个 bin
```

## 接入动线（对齐管理台）

1. 壳 `/admin/modules` → 新增模块 → 反连接入 → 模块 id `demo` → 生成接入码
2. 复制 `UNSELF_MODULE_KEY=<明文>` 到 `.env`（只展示一次；丢了就重新生成）
3. `UNSELF_CORE_URL` 填 core 地址（本地 dev 即 `http://localhost:<PORT>`）
4. 起 hello（任一跑法）→ 工作台「测试连接」绿 → 保存
5. 验证数据面：`GET <core>/m/demo/api/health` → `{"ok":true,"service":"module-hello"}`

包名 `@unself/hello` 即 #76 发布清单中的对外名；bin 名 `unself-hello` 仅为示例，
模块作者自定（#111）。
