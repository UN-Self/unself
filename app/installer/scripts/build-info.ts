#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 构建期身份计算（#287，被 scripts/build-bin.sh 调用）：输出 esbuild `--define` 用的 JSON 字面量。
 *
 * 为什么这个逻辑放在 tsx/node 脚本而不是 shell：commit 解析必须复用 `@unself/contracts`
 * 的 `resolveBuildCommit`（GITHUB_SHA → git rev-parse HEAD → 抛错，形状校验 + 小写归一），
 * 与 `@unself/workbench` 的构建同一套规则——否则安装器与平台产物会说两个版本的「我」，
 * 这正是 #287 要消灭的病。shell 里自拼 `git rev-parse` 就绕开了这套规则（任务书明令禁止）。
 *
 * 输出（stdout，单行）：`{"version":"<app/installer/package.json 的 version>","commit":"<40位SHA>"}`
 * commit 拿不到（无 git、无 GITHUB_SHA）→ 直接退出非零：拒绝产出无 commit 的产物（决策 #80）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveBuildCommit } from '@unself/contracts';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string };
if (!pkg.version) {
  console.error('app/installer/package.json 没有 version 字段——拒绝构建无身份的产物');
  process.exit(1);
}

// git fallback 由这里注入（resolveBuildCommit 本身零副作用，执行器交给调用方）。
const commit = resolveBuildCommit({
  env: process.env,
  git: () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pkgDir, encoding: 'utf8' }),
});

process.stdout.write(JSON.stringify({ version: pkg.version, commit }));
