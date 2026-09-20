#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * @unself/installer 入口（bin）：unself <命令>。
 * 零克隆语义：本包不读仓库、不 clone、不 pnpm install（引擎经依赖随包装好）。
 *
 * 加载策略：src/ 是无后缀 ESM 导入的 TypeScript。
 * - tsx 可直接跑（package.json bin 同理，npm/npx 会挂 .bin）；
 * - 裸 node：Node ≥22.6 会原生剥类型，但 node_modules 内禁用类型剥离
 *   （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）且不解无后缀导入——
 *   捕获后进程内注册 tsx 加载器重试。npx 实测（node 24.20/26.8）两者都能命中，
 *   统一兜底保证一条命令可用。
 */
import { register } from 'tsx/esm/api';

/** 装配 CLI（延迟导入；裸 node 下先注册 tsx 再重试）。 */
async function boot(): Promise<typeof import('./src/cli.ts')> {
  try {
    return await import('./src/cli.ts');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') {
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
