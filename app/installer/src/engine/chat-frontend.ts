// SPDX-License-Identifier: AGPL-3.0-only
/**
 * chat 前端构建产物装配（#219 内容 4；#284 产物入包）：
 * `pnpm --filter @unself/module-chat-frontend build`（vite 配置 outDir = `../assets/frontend`，
 * 相对【构建 cwd】= chat 包根解析 → 产物落 `<chat 包根>/assets/frontend/`）
 * → 装配时搬进 .deploy/cloudflare/modules/chat/assets/frontend/。
 * 每次部署无条件重建（#73 同款纪律：装配器职责 = 始终搬运当前源码树，不吞旧产物）。
 * frontend/src 不在本 issue 边界内：构建变量（live 模式 + 相对 base）是包装配置，
 * 源码零修改（VITE_CHAT_API 双模式为 #218 预留的既有约定）。
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { runTool } from './assemble';

export const CHAT_FRONTEND_FILTER = '@unself/module-chat-frontend';

/**
 * 构建并搬运 chat 前端产物。
 * 产物落点（codex-walk 走查 2026-09-22 实锤）：pnpm --filter 会把 vite 切到前端包目录
 * （<chat 包根>/frontend）执行，outDir `../assets/frontend` 相对 vite root 解析 →
 * 恒为 <chat 包根>/assets/frontend，与 pnpm 启动 cwd 无关。
 * @param outDir 装配产物根（.deploy/cloudflare）
 * @returns 产物目录（相对 outDir/modules/，供 wrangler assets.directory 引用）
 */
export async function buildChatFrontendAssets(input: {
  rootDir: string;
  outDir: string;
  log: (msg: string) => void;
  /** 测试注入口：拦截构建（默认真实 pnpm --filter … exec vite build）。 */
  run?: (cmd: string, args: string[], cwd: string) => Promise<void>;
  /**
   * vite 构建的 cwd（缺省 rootDir）：必须落在 pnpm workspace 内（`pnpm --filter` 向上找
   * pnpm-workspace.yaml）；实例目录不在 workspace 内 → ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE
   * （2026-09-22 走查实锤）。调用方传 chat 包根（源码形态 = 仓库内目录）。
   */
  buildCwd?: string;
  /**
   * 产物形态（#284）：模块包内已预构建的前端目录（`<包根>/assets/frontend`）。
   * 给了就搬运，不跑 vite——干净机器没有 pnpm/vite，也不该有本仓库源码树。
   */
  prebuiltDir?: string;
}): Promise<string> {
  const run = input.run ?? runTool;
  const assetsDir = 'chat/assets/frontend';
  const dest = `${input.outDir}/modules/${assetsDir}`;
  let dist: string;
  if (input.prebuiltDir !== undefined) {
    if (!existsSync(input.prebuiltDir)) {
      throw new Error(
        `模块包不完整：缺 chat 前端产物 ${input.prebuiltDir}——模块包应由 \`unself module pack\` 产出（前端资产随模块包发布）`,
      );
    }
    input.log('搬运 chat 前端产物（模块包内 assets/frontend）…');
    dist = input.prebuiltDir;
  } else {
    input.log('构建 chat 前端（vite build --base=./，live 模式）…');
    await run('pnpm', [
      '--filter', CHAT_FRONTEND_FILTER, 'exec', 'vite', 'build',
      '--base=./', '--emptyOutDir',
    ], input.buildCwd ?? input.rootDir, { env: { VITE_CHAT_API: 'live' } });
    // 产物恒在 <chat 包根>/assets/frontend（见头注释）。两种取法：
    // - buildCwd 明示（steps 传 chat 包根，含 node_modules symlink 形态）→ <buildCwd>/assets/frontend；
    // - 缺省（开发形态 rootDir=仓库根）→ rootDir/app/modules/chat/assets/frontend（历史路径不变）。
    // 用 buildCwd 是否缺省区分，而非 `?? ` 合并——run-cwd 本身不是产物基准（codex-walk 实锤）。
    dist = input.buildCwd === undefined
      ? join(input.rootDir, 'app/modules/chat/assets/frontend')
      : join(input.buildCwd, 'assets/frontend');
    if (!existsSync(dist)) {
      throw new Error(`chat 前端构建产物缺失（${dist}）：vite build 报成功但无产物，先查 frontend 构建`);
    }
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
