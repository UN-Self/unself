// SPDX-License-Identifier: AGPL-3.0-only
/**
 * chat 前端构建产物装配（#219 内容 4）：
 * `pnpm --filter @unself/module-chat-frontend build`（VITE_CHAT_API=live + --base=./）
 * → 产物搬进 .deploy/cloudflare/modules/chat/assets/frontend/。
 * 每次部署无条件重建（#73 同款纪律：装配器职责 = 始终搬运当前源码树，不吞旧产物）。
 * frontend/src 不在本 issue 边界内：构建变量（live 模式 + 相对 base）是包装配置，
 * 源码零修改（VITE_CHAT_API 双模式为 #218 预留的既有约定）。
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { runTool } from './assemble';

export const CHAT_FRONTEND_FILTER = '@unself/module-chat-frontend';

/**
 * 构建并搬运 chat 前端产物。
 * @param outDir 装配产物根（.deploy/cloudflare）
 * @returns 产物目录（相对 outDir/modules/，供 wrangler assets.directory 引用）
 */
export async function buildChatFrontendAssets(input: {
  rootDir: string;
  outDir: string;
  log: (msg: string) => void;
  /** 测试注入口：拦截构建（默认真实 pnpm --filter … exec vite build）。 */
  run?: (cmd: string, args: string[], cwd: string) => Promise<void>;
}): Promise<string> {
  const run = input.run ?? runTool;
  input.log('构建 chat 前端（vite build --base=./，live 模式）…');
  await run('pnpm', [
    '--filter', CHAT_FRONTEND_FILTER, 'exec', 'vite', 'build',
    '--base=./', '--emptyOutDir',
  ], input.rootDir, { env: { VITE_CHAT_API: 'live' } });
  const assetsDir = 'chat/assets/frontend';
  const dest = `${input.outDir}/modules/${assetsDir}`;
  const dist = `${input.rootDir}/modules/chat/frontend/dist`;
  if (!existsSync(dist)) {
    throw new Error(`chat 前端构建产物缺失（${dist}）：vite build 报成功但无 dist，先查 frontend 构建`);
  }
  // 无条件重写（#162 同款纪律）：旧哈希命中的残留 chunk 不留给升级部署
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(
    dist,
    dest,
    { recursive: true },
  );
  input.log(`chat 前端产物已装配（${assetsDir}）`);
  return assetsDir;
}
