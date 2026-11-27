# calendar 模块

日历模块，本期做「编辑日程」：读取一条日程、按版本号乐观锁改字段、通过变更流提示他人改动。

## 目录

- `src/`：worker 入口、认证、路由、事件读写与校验
- `frontend/`：Vue 前端，含 409 对比横幅与 3 秒轮询提示
- `test/`：真 SQLite 跑真迁移的路由级集成测试
- `migrations/calendar/`：D1 迁移
- `scripts/build.mjs`：打包、校验 manifest

## 接口

- `PATCH /api/events/:id`：改字段，必带 `version`；200 回 `{ event, version }`，409 回 `{ error: version_conflict, event, version, actorName }`
- `GET /api/events/:id`：读详情，软删一律 404。归模块自有：变更流只给 eventId，撞车对比必须靠它取完整日程；后续查组若有详情接口再统一口径。
- `GET /api/changes?since=`：变更流，`since` 含当毫秒，cursor 只前进，单次上限 200
- `GET /api/health`、`GET /life/export`、`POST /life/purge`：平台约定接口

## 运行

```bash
pnpm --filter @unself/calendar dev
```

前端：

```bash
pnpm --filter @unself/calendar-frontend dev
```

真接口模式需在工作台或 `frontend/public/dev-shim.html` 里打开，由壳注入 token。

本地 D1 不会自动跑迁移，需先执行 `migrations/calendar/0001_events.sql` 并插入测试行。

PATCH 只允许改自己的日程：行上 `organizer_id` 必须等于 token 的 `sub`，否则 403。

## 校验与产物

```bash
pnpm --filter @unself/calendar typecheck
pnpm --filter @unself/calendar test
node scripts/build.mjs
```

## 部署变量

装容器注入 `MODULE_ID`（实例 id，也是 token 的 aud）、`CORE_JWKS_JSON`、可选 `CORE_ISSUER`；不注 `MODULE_ID` 时回落 `manifest.id`，仅本地调试用。
