// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `workbench` CLI：`@unself/workbench` 的对外入口（bin 名 = 包名末段）。
 *
 * 形态：`npx @unself/workbench [子命令]` / 全局装包后 `workbench [子命令]`。
 * - `start`（缺省，无参数同义）：装配并启动 Node core 进程（HTTP + WS）；
 * - `--version` / `-v`：读构建期烙印 `dist/build-info.json`，打印「包名 版本 @ commit 前 12 位」；
 * - `--help` / `-h` / `help`：用法 + 子命令 + 环境变量清单；
 * - 未知子命令：stderr 报「未知命令」+ 用法，exit 1。
 *
 * 装配逻辑一行不重写：`start` 只是 `startNode()`（`src/entry.node.ts`）的薄壳，
 * config → bootstrapNode（迁移/私钥/setup 链接）→ startHttpServer 全在那条既有路径上。
 *
 * **包根定位推导**（为什么 `dist/node/cli.cjs` 能自己找到 `migrations/core`）：
 * `resolvePackageRoot(import.meta.url)` 从产物所在目录向上试两级——
 * 1. `dist/node/` → `dist/`（无 migrations/core，跳过）；
 * 2. `dist/node/` → 包根（命中 `migrations/core`）。
 * 全局安装形态 = `/usr/local/lib/node_modules/@unself/workbench/dist/node/cli.cjs`，
 * 上两级即 `/usr/local/lib/node_modules/@unself/workbench/`，与仓库内 `app/workbench/` 同形；
 * npx 缓存形态（`~/.npm/_npx/<hash>/node_modules/@unself/workbench/dist/node/cli.cjs`）同理。
 * 所以 bin 不需要知道安装位置，也不需要 cwd 参与。
 *
 * 构建期约束（见 `scripts/build-node.ts`）：本文件的 import.meta.url 在 cli.cjs 里被 define 成
 * **同目录的 entry.node.cjs**——entry.node.ts 的 isMain 守卫按「argv[1] === 模块自身」判定，
 * 若在 cli.cjs 里指向 cli.cjs，`workbench start` 会二次启动（守卫与 start 各起一个）。同目录
 * 不改任何向上推导的结果，构建身份与包根定位都照旧。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBuildInfo } from '@unself/contracts';

import { startNode, type NodeHandle } from './entry.node';

/** 产物自身目录（dist/node/）；构建身份在上一级 dist/（与 cli.cjs/entry.node.cjs 同层级的邻居）。 */
const cliDir = dirname(fileURLToPath(import.meta.url));
const buildInfoPath = join(cliDir, '..', 'build-info.json');

const USAGE: string[] = [
  'workbench —— @unself/workbench 运行体（core 进程 + 工作台，一个包两半边）',
  '',
  '用法：workbench [子命令]',
  '',
  '子命令：',
  '  start           启动 core 进程（HTTP + WS；缺省子命令，不带参数等价）',
  '  --version, -v   打印构建身份（包名 + 版本 + 构建 commit 前 12 位）',
  '  --help, -h      显示本帮助（`help` 同义）',
  '',
  '环境变量（启动时读取，均有缺省值）：',
  '  UNSELF_DB        数据库连接串：sqlite:///abs/path.db | sqlite://:memory: | postgres://…',
  '                   （缺省 sqlite:///app/data/core.db）',
  '  UNSELF_FILES     文件存储：local:/abs/dir 或 s3://bucket?endpoint=…&region=…&accessKeyId=…&secretAccessKey=…；',
  '                   不配 = 头像能力关闭（与未绑定 R2 同义）',
  '  UNSELF_ADDR      监听地址 host:port（缺省 0.0.0.0:8787）',
  '  UNSELF_DATA_DIR  数据目录（缺省 = UNSELF_DB 所在目录；非文件库时 /app/data）',
  '  UNSELF_BASE_URL  setup 深链接用的外部基址（缺省按 localhost 推导；compose 传空串按未设处理）',
  '  JWT_PRIVATE_KEY  签名私钥（PKCS8 PEM）；不配 = 沿用数据目录既有钥，首启生成并落盘 0600',
];

/** 错误对象 → 一行人话（不吞原始 message）。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * SIGTERM/SIGINT → 关闭 handle 后 exit 0（幂等）。
 * 与 `entry.node.ts` 的 isMain 守卫同一模式：本入口是主进程，所以信号在这里挂。
 */
function installShutdownSignals(readHandle: () => NodeHandle | null): void {
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await readHandle()
      ?.close()
      .catch((error: unknown) => console.error('[workbench] 关闭失败', error));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

/** `workbench start`：不传 options（走 process.env 与 resolvePackageRoot），启动失败 exit 1。 */
async function runStart(): Promise<number> {
  let handle: NodeHandle | null = null;
  installShutdownSignals(() => handle);
  try {
    handle = await startNode();
  } catch (error) {
    console.error('[workbench] 启动失败', error);
    return 1;
  }
  // 不 await 任何「结束」：server/tunnel 的句柄撑着事件循环，进程靠 SIGTERM/SIGINT 收尾。
  return 0;
}

/** `workbench --version`：只信构建期烙印；缺失/非法 → 人话错误 + exit 1（不伪造版本）。 */
function runVersion(): number {
  let text: string;
  try {
    text = readFileSync(buildInfoPath, 'utf8');
  } catch (error) {
    console.error(
      `[workbench] 读不到构建身份：${buildInfoPath}（${describeError(error)}）\n` +
        '  该文件由构建期写入（`pnpm --filter @unself/workbench build:node` / `build:worker`）。\n' +
        '  缺失说明这不是完整构建产物——不伪造版本号，请先构建或重新安装发布包。',
    );
    return 1;
  }
  try {
    const info = parseBuildInfo(text);
    // 契约形状：`@unself/workbench <version> @ <commit 前 12 位>`（commit 由 schema 保证 40 位小写）。
    console.log(`${info.package} ${info.version} @ ${info.commit.slice(0, 12)}`);
    return 0;
  } catch (error) {
    console.error(
      `[workbench] 构建身份不可用：${buildInfoPath}\n  ${describeError(error)}\n` +
        '  构建产物版本不可自证时拒绝放行——请重新构建/重新安装，不要手改该文件。',
    );
    return 1;
  }
}

/** 解析 argv → 退出码（start 分支返回后进程仍被 server 句柄撑住）。 */
export async function run(argv: string[]): Promise<number> {
  const command = argv[0];

  // 无参数 = start：容器与裸机同一条命令。
  if (command === undefined || command === 'start') return runStart();

  if (command === '--version' || command === '-v') return runVersion();

  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE.join('\n'));
    return 0;
  }

  console.error(`未知命令：${command}`);
  console.error(USAGE.join('\n'));
  return 1;
}

run(process.argv.slice(2))
  .then((code) => {
    // 非 0 才落 exitCode：start 正常路径不能因为「返回 0」提前结束 server 的句柄。
    if (code !== 0) process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('[workbench] 未捕获错误', error);
    process.exit(1);
  });
