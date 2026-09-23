// SPDX-License-Identifier: AGPL-3.0-only
/**
 * dist/web 定位（发布纪律）：向导 SPA 静态产物目录唯一真源。
 *
 * - 发布形态（dist/unself.mjs）：静态产物与 bundle 同级 → <bundle目录>/web；
 * - 仓库开发形态（tsx 跑 src/）：dist/web 在包根 → 逐级向上找 name=@unself/installer 的 package.json。
 * 绝不依赖 process.cwd()（全局安装 / 任意目录启动都要能用）。
 * 找不到 = 构建产物缺失，抛人话错（指引 pnpm build），不静默返回空目录。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 读取 package.json 的 name（读不到/坏 JSON 返回 null）。 */
function pkgName(pkgPath: string): string | null {
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
    return typeof raw.name === 'string' ? raw.name : null;
  } catch {
    return null;
  }
}

/** 候选目录（纯函数，可单测）：形态一 bundle 同级 web/；形态二包根 dist/web。 */
export function webDistDirCandidates(fromFile: string): string[] {
  const here = dirname(fromFile);
  const candidates = [join(here, 'web')];
  let dir = here;
  for (let guard = 0; guard < 12; guard += 1) {
    if (pkgName(join(dir, 'package.json')) === '@unself/installer') {
      candidates.push(join(dir, 'dist', 'web'));
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

/** 返回可用的 dist/web 绝对目录（以 index.html 存在为准）；没有就抛人话错。 */
export function resolveWebDistDir(fromFile = fileURLToPath(import.meta.url)): string {
  for (const candidate of webDistDirCandidates(fromFile)) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  throw new Error('向导页面产物缺失：先在安装器包根执行 `pnpm build`（生成 dist/web），再启动向导');
}
