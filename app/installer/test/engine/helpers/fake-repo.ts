// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 假仓库根（#303）：装配器要一个 `rootDir`（写 `.deploy/` 与 `unself.lock` 的地方），
 * 而平台产物与官方模块都不再从 rootDir 读——前者来自 `@unself/workbench` 包（夹具合成），
 * 后者来自 node_modules（`localPackageDir` 解析）。
 *
 * 事故教训（#303）：原先用整目录 symlink 把仓库的 `app` 链进临时根，结果
 * `writeFixture(rootDir,'app/modules/<id>')` 直接穿透写进了真仓库（`app/modules/` 被塞进 6 个假模块）。
 * 规矩：**只软链会被读的目录，会被写的目录一律真建**——现在被读的目录只剩 `core/adapters`（模块夹具用），
 * 平台产物改成真建的 `wb/`（合成包），不再软链仓库的 `app/workbench`。
 */
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT } from '../../helpers/repo-root';
import { writeWorkbenchFixture } from './workbench-fixture';

/** 假仓库里冒充 `@unself/workbench` 的包目录名（相对 rootDir）。 */
export function workbenchDirOf(rootDir: string): string {
  return join(rootDir, 'wb');
}

/** 造一个假仓库根（临时目录；调用方负责 rm -rf）。 */
export async function makeFakeRepoRoot(prefix = 'unself-fakerepo-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  // 被写的目录：真建（不软链 app 整层）
  await mkdir(join(root, 'app', 'modules'), { recursive: true });
  // 平台产物：合成一个 workbench 包（真建，不软链仓库的 app/workbench）
  await writeWorkbenchFixture(workbenchDirOf(root));
  // 被读的目录：软链（模块夹具要真 Stalwart 适配器源码）
  await symlink(join(REPO_ROOT, 'core'), join(root, 'core'), 'dir');
  return root;
}

/**
 * 临时 workbench 夹具（用真仓库根当 rootDir 的测试用：`ROOT` 里没有可依赖的 `app/workbench/dist`——
 * 测试不该依赖「先跑过 build」，所以合成一份在 /tmp）。用 `cleanupTempWorkbenches()` 收尾。
 */
const tempWorkbenches: string[] = [];

/** 造一份临时 workbench 夹具包（返回包目录）。 */
export async function tempWorkbenchDir(prefix = 'unself-wb-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempWorkbenches.push(dir);
  return writeWorkbenchFixture(dir, { version: '0.0.0-test' });
}

/** 清掉本文件造过的全部临时夹具（测试 afterAll 调一次）。 */
export async function cleanupTempWorkbenches(): Promise<void> {
  while (tempWorkbenches.length > 0) {
    await rm(tempWorkbenches.pop()!, { recursive: true, force: true });
  }
}
