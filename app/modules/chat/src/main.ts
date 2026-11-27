// SPDX-License-Identifier: AGPL-3.0-only
/**
 * chat 的 node 入口（#382 轨道 D）：自部署形态的启动文件。
 *
 * CF 部署走 `worker/src/index.js` 的 `export default { fetch, scheduled }`，env 由平台
 * 注入（D1 / KV / 三个 DO）。自部署时同一份业务代码由这里启动，缺的三样由
 * `@unself/sdk/host` 补齐：
 *
 * - `env.DB`        → sqlite 文件上的 D1 形状绑定（`createSqliteD1`）。chat 的 SQL 本来就
 *                     是 SQLite 方言，落 sqlite 不需要方言改写；
 * - `CHANNEL_ROOM` / `USER_INBOX` / `SCHEDULER` → DO 替身（`moduleEnv.durableObjects`）；
 * - `ctx`           → host 注入的最小执行上下文。
 *
 * 业务代码一行不改：`worker/src/*` 在两边的差别只有「谁往 env 里塞东西」。
 *
 * **模块自己的迁移自己跑**：D1 上由装配器代跑，自部署时库在本机，属于 storage=self 的
 * 模块自治范围。记账表 `chat_migrations`，按文件名跳过（AGENTS.md：多模块共用库时
 * 各自独立记账，否则同名迁移会被跳过）。
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyModuleMigrations,
  createSqliteD1,
  readModuleMigrations,
  startDialHome,
  type DurableObjectNamespaceLike,
} from '@unself/sdk/host';

import app, { ChannelRoom, Scheduler, UserInbox } from '../worker/src/index.js';

/** 包根（src/main.ts 与 dist/main.js 都是一级文件，一层 .. 即包根）。 */
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 库文件：默认落包内 `.data/`，容器里用 `UNSELF_MODULE_DB` 指到挂载卷。 */
const DB_PATH = process.env.UNSELF_MODULE_DB ?? join(ROOT, '.data/chat.db');

await mkdir(dirname(DB_PATH), { recursive: true });
const store = createSqliteD1({ path: DB_PATH });
const migrations = await applyModuleMigrations(
  store.db,
  'chat',
  await readModuleMigrations(join(ROOT, 'migrations/chat')),
);
console.log(
  `chat 模块库就绪：${DB_PATH}（迁移 应用 ${migrations.applied.length} / 跳过 ${migrations.skipped.length}）`,
);

const handle = startDialHome({
  // Hono 的 fetch(request, env, executionCtx) 与 CF 形状一致；env/ctx 由 host 注入。
  handler: (request, env, ctx) => app.fetch(request, env, ctx),
  moduleEnv: {
    bindings: { DB: store.db },
    durableObjects: {
      CHANNEL_ROOM: ChannelRoom,
      USER_INBOX: UserInbox,
      SCHEDULER: Scheduler,
    },
  },
});

/**
 * 把 GC 闹钟挂上（一次性、幂等）：CF 上 `Scheduler.fetch` 由健康检查/安装器触发，
 * 自部署时没人触发它，不挂闹钟就等于 GC 永远不跑。`Scheduler` 自己会算
 * 「下一个 UTC 03:00」并在每次 `alarm()` 后重排。
 */
const scheduler = handle.env.SCHEDULER as DurableObjectNamespaceLike | undefined;
if (scheduler) {
  await scheduler.get(scheduler.idFromName('gc')).fetch('https://scheduler.internal/');
}

const addr = handle.addr();
console.log(`chat 模块已就绪：${addr ? `http://${addr}/` : '（监听中）'}`);
if (process.env.UNSELF_CORE_URL && process.env.UNSELF_MODULE_KEY) {
  console.log(`已开始反连 ${process.env.UNSELF_CORE_URL}`);
} else {
  console.log('未配置 UNSELF_CORE_URL / UNSELF_MODULE_KEY：只跑本地 HTTP，不拨号');
}

const shutdown = () => {
  handle.stop();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
