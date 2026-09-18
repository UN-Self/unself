// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 迁移闸门自动发现（#248 验收⑨）：`scripts/check-migrations-upgrade.mjs` 必须**自动遍历**仓库里的
 * migrations 目录——新模块带 `migrations/<id>/` 进仓即入闸门，不需要改脚本。
 *
 * 这里的行为测试跑**真脚本**（spawn node），断言的是脚本输出与退出码，不是源码字符串：
 * - 真仓库：发现清单必须包含 #248 新增的两个目录（chat 迁移链、平台 modules 库迁移）
 *   —— 红灯：把发现逻辑换回硬编码清单（#248 前的 core + hello 两项）→ 清单少这两项 → 本测红。
 * - 临时假仓库：只放一个从没见过的模块目录 → 也必须被发现（同一门禁的泛化证明）。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-migrations-upgrade.mjs');

/** 跑闸门脚本，回 { code, out }（stdout+stderr 合并，审计可见原文）。 */
function runGate(cwd: string, scriptPath = SCRIPT): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], { cwd });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code: number | null) => resolve({ code: code ?? 1, out }));
  });
}

describe('迁移闸门目录自动发现（#248）', () => {
  it('真仓库：发现清单含 chat 迁移链与平台 modules 库迁移（硬编码清单会漏掉它们）', { timeout: 120_000 }, async () => {
    const { code, out } = await runGate(REPO_ROOT);
    expect(out).toContain('modules/chat/migrations/chat');
    expect(out).toContain('services/core-api/migrations/modules');
    expect(out).toContain('services/core-api/migrations/core');
    expect(code).toBe(0);
  });

  it('临时假仓库：全新模块目录零改动纳入闸门（同一脚本，不改一行）', { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'unself-gate-'));
    try {
      await mkdir(join(root, 'scripts'), { recursive: true });
      await cp(SCRIPT, join(root, 'scripts', 'check-migrations-upgrade.mjs'));
      const dir = join(root, 'modules', 'fresh-mod', 'migrations', 'fresh-mod');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, '0001_init.sql'),
        'CREATE TABLE IF NOT EXISTS fresh_mod_items (id INTEGER PRIMARY KEY);\n',
      );
      await writeFile(
        join(dir, '0002_more.sql'),
        'CREATE TABLE IF NOT EXISTS fresh_mod_tags (id INTEGER PRIMARY KEY);\n',
      );
      const { code, out } = await runGate(root, join(root, 'scripts', 'check-migrations-upgrade.mjs'));
      expect(out).toContain('modules/fresh-mod/migrations/fresh-mod');
      expect(out).toContain('✓'); // 升级路径可测（2 个文件 → 1 个切断点）且通过
      expect(code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('红灯锚点：假仓库里没有任何 migrations 目录 → 清单为空（硬编码清单在别的仓库必然对不上）', { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'unself-gate-empty-'));
    try {
      await mkdir(join(root, 'scripts'), { recursive: true });
      await cp(SCRIPT, join(root, 'scripts', 'check-migrations-upgrade.mjs'));
      const { code, out } = await runGate(root, join(root, 'scripts', 'check-migrations-upgrade.mjs'));
      expect(out).toContain('受闸门的迁移目录（自动发现）：');
      expect(out).toContain('✓ 跨版本迁移闸门通过');
      expect(code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
