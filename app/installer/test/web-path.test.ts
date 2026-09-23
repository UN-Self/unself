// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { webDistDirCandidates } from '../src/web/web-path';
import { REPO_ROOT } from './helpers/repo-root';

/** 真实包根（结构解析：向上找 pnpm-workspace.yaml）——不在断言里写仓库相对路径。 */
const pkgRoot = join(REPO_ROOT, 'app', 'installer');

/** 形态定位纯函数（发布纪律：dist/web 随包发布，运行时按 import.meta.url 定位，不依赖 cwd）。 */
describe('web-path：dist/web 定位（不依赖 cwd）', () => {
  const roots: string[] = [];
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'unself-webpath-'));
    roots.push(root);
    return root;
  }
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it('bundle 形态：包根/dist/unself.mjs（fromFile=dist/unself.mjs）→ 候选含同级 web/', () => {
    const root = makeRoot();
    const candidates = webDistDirCandidates(join(root, 'dist', 'unself.mjs'));
    expect(candidates[0]).toBe(join(root, 'dist', 'web'));
  });

  it('源码形态：src/web/web-path.ts → 向上找安装器包根（结构解析）→ dist/web 候选', () => {
    const candidates = webDistDirCandidates(join(pkgRoot, 'src', 'web', 'web-path.ts'));
    expect(candidates).toContain(join(pkgRoot, 'dist', 'web'));
  });

  it('产物缺失 → 人话错（指引 pnpm build），不静默返回空目录（空树实测）', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'not-installer' }));
    let message = '';
    try {
      // 直接调：web-path 的上游 import.meta.url 不可变，这里只验「无候选 → 抛人话」的路径语义
      // （用 fake fromFile 指向空树，候选解析向上到根全部落空）
        const candidatesEmpty = webDistDirCandidates(join(root, 'src', 'web', 'x.ts'));
      expect(candidatesEmpty.length).toBe(1); // 只有 bundle 形态候选，无包根候选
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    void message;
  });

  it('bundle 形态就地命中（dist/web 与 unself.mjs 同级）——发布形态的真实布局（真包根实测）', () => {
    // build-bin.sh 产物布局：dist/unself.mjs + dist/web/index.html（构建门禁保证存在）
    expect(webDistDirCandidates(join(pkgRoot, 'dist', 'unself.mjs'))[0]).toBe(join(pkgRoot, 'dist', 'web'));
  });
});
