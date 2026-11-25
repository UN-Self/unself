// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node 运行体入口（#360 轨道 A）：不依赖 Cloudflare 的 core 进程。
 *
 * **deprecated（对外入口）**：直接运行本文件等价于 `workbench start`；新入口见 `src/cli.ts`
 * （产物 `dist/node/cli.cjs`，bin 名 `workbench`）。本文件保留为装配实现 + 直跑形态。
 *
 * 启动（两参数 + 可选）：
 *   UNSELF_DB=sqlite:///abs/path/core.db node dist/node/entry.node.mjs
 *   UNSELF_DB=postgres://user:pass@host:5432/db node dist/node/entry.node.mjs
 *
 * 组合顺序：config → bootstrap（迁移/私钥/头像/首启 token）→ HTTP server（含 WS upgrade）。
 * 本文件只做进程生命周期；运行期适配在 `src/node/`，请求链路与 Worker 共用 `prod-handler`。
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import type { NodeConfig } from './node/config';
import { readNodeConfig, resolvePackageRoot } from './node/config';
import { bootstrapNode } from './node/bootstrap';
import { startHttpServer } from './node/server';

export interface StartNodeOptions {
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  quiet?: boolean;
  /** 测试/嵌入用：覆盖解析后的配置字段（addr/port/database/assetsDir…）。 */
  config?: Partial<NodeConfig>;
}

export interface NodeHandle {
  url: string;
  port: number;
  config: NodeConfig;
  runtime: Awaited<ReturnType<typeof bootstrapNode>>;
  close(): Promise<void>;
}

/** 起一个完整的 Node core 进程（测试与 `main` 共用同一条装配路径）。 */
export async function startNode(options: StartNodeOptions = {}): Promise<NodeHandle> {
  const env = options.env ?? process.env;
  const packageRoot = options.packageRoot ?? resolvePackageRoot(import.meta.url);
  const config: NodeConfig = { ...readNodeConfig(env, packageRoot), ...options.config };
  const runtime = await bootstrapNode(config, env, { quiet: options.quiet });
  const server = await startHttpServer({
    app: runtime.app,
    env: runtime.env,
    tunnel: runtime.tunnel,
    host: config.host,
    port: config.port,
  });
  if (!options.quiet) {
    console.log(`[node] workbench 监听 http://${config.host}:${server.port}（方言 ${runtime.database.dialect}）`);
  }
  return {
    url: server.url,
    port: server.port,
    config,
    runtime,
    async close(): Promise<void> {
      await server.close();
      await runtime.close();
    },
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMain = invokedPath === modulePath;

if (isMain) {
  let handle: NodeHandle | null = null;
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await handle?.close().catch((error: unknown) => console.error('[node] 关闭失败', error));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  startNode()
    .then((started) => {
      handle = started;
    })
    .catch((error: unknown) => {
      console.error('[node] 启动失败', error);
      process.exit(1);
    });
}
