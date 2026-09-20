// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 假仓库根（#303）：装配器的「仓库形态」会**读**仓库里的几个目录，而测试要往里**写**东西。
 *
 * 事故教训（#303）：原先用整目录 symlink 把仓库的 `app` 链进临时根，结果
 * `writeFixture(rootDir,'app/modules/<id>')` 直接穿透写进了真仓库（`app/modules/` 被塞进 6 个假模块）。
 * 规矩：**只软链会被读的目录，会被写的目录一律真建**。
 *
 * 哪些是「被读」：`core/adapters`（Stalwart 适配器）、`app/workbench/{src,migrations}`（core Worker 入口与迁移 SQL）。
 * 哪些是「被写」：`app/workbench/dist`（壳产物，由注入的 buildShell 写）、`app/modules/<夹具>`。
 */
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../../helpers/repo-root';

/** 造一个假仓库根（临时目录；调用方负责 rm -rf）。 */
export async function makeFakeRepoRoot(prefix = 'unself-fakerepo-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  // 被写的目录：真建（不软链 app 整层）
  await mkdir(join(root, 'app', 'workbench', 'dist'), { recursive: true });
  await mkdir(join(root, 'app', 'modules'), { recursive: true });
  // 被读的目录：软链
  await symlink(join(REPO_ROOT, 'core'), join(root, 'core'), 'dir');
  for (const rel of ['src', 'migrations']) {
    await symlink(join(REPO_ROOT, 'app', 'workbench', rel), join(root, 'app', 'workbench', rel), 'dir');
  }
  return root;
}

/** 写一个最小壳产物（注入 buildShell 用；真 vite build 约 4.4s/次，套件会超时——#73 每次部署都重建）。 */
export async function seedShellDist(root: string): Promise<void> {
  const dist = join(root, 'app', 'workbench', 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<html><body>TEST SHELL</body></html>');
}
