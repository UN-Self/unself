#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * @unself/installer 入口（bin）：unself <命令>。
 * 零克隆语义：本包不读仓库、不 clone、不 pnpm install（引擎经依赖随包装好）。
 * src/ 是无后缀 ESM 导入的 TypeScript：tsx 直接跑得动；裸 node 原生剥类型但解析不了
 * 无后缀导入，此时进程内注册 tsx 加载器重试（与 deploy/cloudflare/bin.ts 同款）。
 */
import { register } from 'tsx/esm/api';

/** 装配 CLI（延迟导入；裸 node 下先注册 tsx 再重试）。 */
async function boot(): Promise<typeof import('./src/cli.ts')> {
  try {
    return await import('./src/cli.ts');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    }
    register();
    return await import('./src/cli.ts');
  }
}

const { run } = await boot();
await run({
  argv: process.argv.slice(2),
  env: process.env,
  home: (await import('node:os')).homedir(),
  cwd: process.cwd(),
  log: (line) => console.log(line),
  err: (line) => console.error(line),
  exit: (code) => {
    process.exitCode = code;
  },
});
