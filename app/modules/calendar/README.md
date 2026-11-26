# @unself/calendar

日历与日程管理模块。同一份业务代码支持 Cloudflare Worker，以及通过 Workbench 反连接入的 Node/Docker 本地运行方式。

## 本地运行

先启动本地 Workbench，并在管理台「新增模块 → 反连接入」创建 `calendar`，取得模块 key。

```bash
cp .env.example .env
# 填写 UNSELF_CORE_URL 与 UNSELF_MODULE_KEY
pnpm --filter @unself/calendar dev
```

宿主默认监听 `127.0.0.1:8790`（Docker 部署在 `compose.yml` 里显式设 `0.0.0.0:8791` 以打通端口映射），同时主动连接 Workbench。连接成功后即可在模块列表打开 Calendar。

## Docker

```bash
pnpm --filter @unself/calendar pack --pack-destination app/modules/calendar
docker compose -f app/modules/calendar/compose.yml up --build
```

Dockerfile 会安装刚生成的 `unself-calendar-*.tgz`，运行与本地 Node 模式相同的 `unself-calendar` 入口。

## 验证

```bash
pnpm --filter @unself/calendar test
pnpm --filter @unself/calendar build
```

日程数据使用 Core 的 `module-api/storage` 接口，因此不依赖 Cloudflare R2。

> AI生成
