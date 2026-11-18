# Unself 本地运行交付包

本包包含 Workbench、Hello、Calendar 和 Chat。默认使用 Docker 本地运行：

- Workbench：`http://localhost:8787`
- Hello：反连接入 Workbench
- Calendar：反连接入 Workbench
- Chat：`http://localhost:8792`，由 Workbench 通过模块 token 装载
- 不需要 Cloudflare 账号或 Cloudflare R2

## 环境

- Windows 10/11 + WSL2
- Docker Desktop（Linux containers）
- Node.js >= 22（运行本地 Chat 注册脚本）
- pnpm >= 11（仅在需要重新构建源码时使用）

## 首次启动

Windows 压缩工具有时会把 `.sh` 转成 CRLF；Docker 镜像构建阶段会自动转换为 LF，
因此使用 PowerShell、资源管理器、WinRAR、Bandizip 或 7-Zip 正常解压均可。

```powershell
cd unself
Copy-Item docker\.env.example docker\.env

docker compose --env-file docker\.env -f docker\compose.yml build workbench
docker compose --env-file docker\.env -f docker\compose.yml up -d workbench
docker compose --env-file docker\.env -f docker\compose.yml logs --tail=120 workbench
```

从 Workbench 日志复制一次性 Setup 链接，打开并创建管理员。

## 接入 Hello 和 Calendar

在 Workbench 管理台创建 Hello、Calendar 的反连接入码，然后写入 `docker/.env`：

```dotenv
HELLO_MODULE_KEY=...
CALENDAR_MODULE_KEY=...
```

构建并启动：

```powershell
docker compose --env-file docker\.env -f docker\compose.yml --profile modules build hello calendar
docker compose --env-file docker\.env -f docker\compose.yml --profile modules up -d hello calendar
```

## 启动 Chat

Chat 直接运行在独立的 Wrangler/Workerd 容器中，不需要接入 key：

```powershell
docker compose --env-file docker\.env -f docker\compose.yml --profile modules build chat
docker compose --env-file docker\.env -f docker\compose.yml --profile modules up -d chat
node scripts\register-local-chat.mjs
```

Chat 首次启动会在 `unself-chat-data` 数据卷中生成消息加密 keyring。

## 验收

```powershell
Invoke-RestMethod http://localhost:8787/api/health
Invoke-RestMethod http://localhost:8792/api/health
Invoke-RestMethod http://localhost:8787/api/modules
```

浏览器打开 `http://localhost:8787`，确认：

- Hello 可以打开；
- Calendar 可以新增日程并在刷新后保留；
- Chat 可以发送文本消息并在刷新后保留。

## 数据与安全

持久化 Docker volumes：

- `docker_unself-data`：Workbench D1、JWT 私钥
- `docker_unself-chat-data`：Chat D1、KV/DO 状态和消息加密 keyring

不要执行 `docker compose down -v`，否则会删除本地数据。

`.env`、本地数据库、Docker volumes、JWT 私钥和 Chat encryption keyring 均不包含在源码 ZIP 中。

## 重新构建源码

如果修改了源码：

```powershell
pnpm install --frozen-lockfile
pnpm pack:local-modules
pnpm build:local-chat
pnpm --filter @unself/workbench build
```

然后按上面的 Docker build 命令重建镜像。
