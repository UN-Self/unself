#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * deploy/cloudflare 入口：仓库根执行 `node deploy/cloudflare/bin.ts`（文档唯一启动方式）。
 *
 * src/ 是无后缀 ESM 导入的 TypeScript：tsx（本包既有依赖，零新增）直接跑得动；
 * 裸 node ≥22.6 原生剥类型但解析不了无后缀导入，此时进程内注册 tsx 加载器重试。
 * 不重开进程，TTY/管道/信号天然透传。
 */
import { register } from 'tsx/esm/api';

async function boot(): Promise<typeof import('./src/main.ts')> {
  try {
    return await import('./src/main.ts');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    }
    register();
    return await import('./src/main.ts');
  }
}

const { main } = await boot();
main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exitCode = 1;
});
