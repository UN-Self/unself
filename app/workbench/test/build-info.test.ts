// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 构建产物行为测试（#287，决策 #80）：断言 `dist/build-info.json` 真实存在且身份成立——
 * 不是断言源码/文案，而是断言**构建产物**这一行为结果。产物不存在 → 直接失败并提示先跑
 * build（不 skip：静默跳过会让「产物无烙印」溜进发布，正是本 issue 要堵的洞）。
 *
 * 产物定位走 workspace 标记向上找（`pnpm-workspace.yaml` → 仓库根 → 包路径），
 * 与 app/installer/test/helpers/repo-root.ts 同范式：不按目录深度硬算，搬目录不哑。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseBuildInfo } from '@unself/contracts';

/** 从 fromDir 逐级向上找 `pnpm-workspace.yaml`（仓库稳定标记），返回仓库根绝对路径。 */
function findRepoRoot(fromDir: string): string {
  let dir = fromDir;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`找不到仓库根：从 ${fromDir} 向上没有 pnpm-workspace.yaml`);
    dir = parent;
  }
}

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const pkgDir = join(repoRoot, 'app', 'workbench');
const buildInfoPath = join(pkgDir, 'dist', 'build-info.json');

async function requireBuildInfoText(): Promise<string> {
  try {
    return await readFile(buildInfoPath, 'utf8');
  } catch {
    throw new Error(
      `构建产物不存在：${buildInfoPath} —— 请先跑 \`pnpm --filter @unself/workbench build\` 再跑测试` +
        '（构建期版本烙印是产物的一部分，缺失即交付物不完整，不允许静默跳过）',
    );
  }
}

describe('dist/build-info.json（构建期版本烙印）', () => {
  it('存在且四键齐全：package=@unself/workbench、version=包版本、commit=40 位十六进制、builtAt', async () => {
    const { name, version } = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    const info = parseBuildInfo(await requireBuildInfoText());

    expect(info.package).toBe(name);
    expect(info.package).toBe('@unself/workbench');
    expect(info.version).toBe(version);
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(info.builtAt).toBeTruthy();
  });
});
