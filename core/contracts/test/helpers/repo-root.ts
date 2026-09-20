// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 测试用仓库根定位（#303 纪律：**测试不得按目录深度硬算仓库根**）。
 *
 * 为什么：`new URL('../../../..', import.meta.url)` 这类写法在搬目录时**不会报错**，
 * 只会静默算到别的目录（#303 当天一次踩出 14 处，报出「模块目录不存在」这种由路径算歪引起的错）。
 * 行为测试不该输在目录位置上——所以向上找 `pnpm-workspace.yaml`（仓库的稳定标记），
 * 目录怎么搬、包怎么改名都不影响。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从 fromDir 逐级向上找 `pnpm-workspace.yaml`，返回仓库根绝对路径。 */
export function findRepoRoot(fromDir: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = fromDir;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`找不到仓库根：从 ${fromDir} 向上没有 pnpm-workspace.yaml`);
    }
    dir = parent;
  }
}

/** 本测试进程所在的仓库根（探针一次，后续复用）。 */
export const REPO_ROOT = findRepoRoot();
