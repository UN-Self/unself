// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 构建期版本烙印（#287，决策 #80）：往 `dist/build-info.json` 写构建身份，
 * 让产物自证「线上跑的哪一版」。身份解析复用 `@unself/contracts` 的
 * `createBuildInfo` / `resolveBuildCommit`——与 installer 同一套 commit 规则。
 *
 * 落点说明（**为什么在 `dist/` 那层**）：vite 的 `emptyOutDir` 只清 `dist/web/`
 * （outDir 那层），本文件写在它的上一级 `dist/build-info.json`，两条构建路径
 * （vite 前端构建 / build-worker 后端打包）都**不会**把它清掉；两边写同一路径、
 * 同一键集合、整文件覆盖写——谁先谁后内容等价，天然幂等。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuildInfo, resolveBuildCommit } from '@unself/contracts';

/** 本脚本所在目录 = app/workbench/scripts。 */
const scriptsDir = dirname(fileURLToPath(import.meta.url));
/** 包目录 = app/workbench（不硬编码仓库相对路径，随脚本位置走）。 */
const pkgDir = join(scriptsDir, '..');
/** 烙印落点：app/workbench/dist/build-info.json（dist/web 的上一级，emptyOutDir 清不到）。 */
const buildInfoPath = join(pkgDir, 'dist', 'build-info.json');

/**
 * 从包自身的 package.json 读 name/version（单一职责：版本唯一来源是包清单，
 * 不在构建脚本里维护第二份版本号）。
 */
async function readPackageIdentity(): Promise<{ name: string; version: string }> {
  const raw = await readFile(join(pkgDir, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error(`package.json 缺 name/version，无法烙印构建身份：${join(pkgDir, 'package.json')}`);
  }
  return { name: parsed.name, version: parsed.version };
}

/**
 * git 兜底：`git rev-parse HEAD`。
 *
 * 容错目标：`git` 不存在（ENOENT）或当前目录不是 git 仓库（退出码非 0）时，
 * 抛出**可读**错误——让 `resolveBuildCommit` 最终以「拿不到构建 commit」失败，
 * 而不是漏出 execFileSync 的原始堆栈把人引向错误方向。
 */
function gitHead(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (/ENOENT/i.test(reason)) {
      throw new Error('找不到 git 可执行文件——本地构建需要 git 来取 commit（或由 CI 提供 GITHUB_SHA）');
    }
    throw new Error(`git rev-parse HEAD 失败（不在 git 仓库内？）：${reason.trim()}`);
  }
}

/**
 * 组装并写入 `dist/build-info.json`（幂等覆盖写）。
 *
 * commit 解析与校验全在 `@unself/contracts`：`GITHUB_SHA` 优先（CI），
 * 其次本地 `git rev-parse HEAD`；都没有 → 抛错、构建失败——绝不产出无 commit 的产物。
 */
export async function writeBuildInfo(): Promise<void> {
  const { name, version } = await readPackageIdentity();
  const commit = resolveBuildCommit({ env: process.env, git: gitHead });
  const buildInfo = createBuildInfo({ package: name, version, commit, builtAt: new Date().toISOString() });
  await mkdir(dirname(buildInfoPath), { recursive: true });
  await writeFile(buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
  console.log(`✓ 构建身份 → ${buildInfoPath}（${buildInfo.version} @ ${buildInfo.commit.slice(0, 12)}）`);
}
