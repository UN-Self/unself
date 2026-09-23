// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 安装器构建期身份烙印的行为测试（#287，决策 #80）。
 *
 * 被测行为 = `scripts/build-info.ts` 的真实产出：给一组 env，它应该吐出哪一份身份 JSON。
 * 这是安装器产物 commit 的**唯一来源**（build-bin.sh 把它喂给 esbuild --define），
 * 所以「commit 从哪来」必须在这里测实——而不是只在文档里承诺。
 *
 * 两条来源都要覆盖（任务书硬要求）：`GITHUB_SHA`（CI）与 `git rev-parse HEAD`（本地）；
 * 并验证形状不合法时**不伪造**（回落 git / 最终失败，绝不把垃圾当 SHA 发出去）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkgDir = join(import.meta.dirname, '..');
const scriptPath = join(pkgDir, 'scripts', 'build-info.ts');
const tsxBin = join(pkgDir, 'node_modules', '.bin', 'tsx');

/** 跑一遍构建烙印脚本（子进程 = 它的真实运行形态），返回解析后的 JSON。 */
function runStamp(env: Record<string, string>): { version: string; commit: string } {
  const stdout = execFileSync(tsxBin, [scriptPath], {
    cwd: pkgDir,
    encoding: 'utf8',
    // 注入受控 env：显式决定 GITHUB_SHA 有无，避免宿主环境污染用例
    env: { ...process.env, ...env },
  });
  return JSON.parse(stdout.trim()) as { version: string; commit: string };
}

/** 安装器包版本真值（按包名判据，不硬算仓库路径）。 */
function installerVersion(): string {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

describe('安装器构建期身份烙印（scripts/build-info.ts）', () => {
  it('CI 来源：GITHUB_SHA 生效并归一小写，version = 包版本', () => {
    const r = runStamp({ GITHUB_SHA: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' });
    expect(r.version).toBe(installerVersion());
    expect(r.commit).toBe('abcdef0123456789abcdef0123456789abcdef01');
  });

  it('本地来源：无 GITHUB_SHA 时回落 git rev-parse HEAD，且与真实 HEAD 一致', () => {
    const { GITHUB_SHA: _drop, ...envWithoutSha } = process.env;
    const r = runStamp(envWithoutSha as Record<string, string>);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pkgDir, encoding: 'utf8' }).trim();
    expect(r.commit).toBe(head);
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('GITHUB_SHA 形状不可信（短 SHA）→ 不伪造，回落 git 真实 HEAD', () => {
    const r = runStamp({ GITHUB_SHA: 'deadbeef' });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pkgDir, encoding: 'utf8' }).trim();
    expect(r.commit).toBe(head);
    expect(r.commit).not.toBe('deadbeef');
  });

  it('两条来源都不可用（git 不可执行 + 无 GITHUB_SHA）→ 非零退出，不产出伪造身份', () => {
    // 模拟干净机器无 git：PATH 指到空目录（脚本内部的 execFileSync('git') 直接 ENOENT）。
    const emptyPath = mkdtempSync(join(tmpdir(), 'unself-nogit-'));
    try {
      expect(() =>
        execFileSync(tsxBin, [scriptPath], {
          cwd: pkgDir,
          encoding: 'utf8',
          env: { ...process.env, GITHUB_SHA: '', PATH: emptyPath },
        }),
      ).toThrow();
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });
});
