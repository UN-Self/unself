// SPDX-License-Identifier: AGPL-3.0-only
/**
 * bin.ts 自举冒烟（#193 T4）：裸 node 直接跑入口（不带 tsx 前缀、不带凭证、非 TTY），
 * 验证「node ≥22.6 原生剥类型失败 → 进程内注册 tsx 加载器重试」这条生产默认启动路径：
 * - 打印 token 第一屏（未检测到 CLOUDFLARE_API_TOKEN + CF 深链接 + export 指引）；
 * - 不进入九步（无 wrangler 资源操作输出）；
 * - 优雅退出：exit code 1（缺凭证的既定语义）且 stderr 只有 main 的一行人话，
 *   无未捕获异常堆栈（堆栈 = 自举失败，属缺陷）。
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/** 仓库根（本文件在 deploy/cloudflare/test/ 下，上三级）。 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

interface RunResult {
  stdout: string;
  stderr: string;
}

/** 期望 exit 0 的运行；非零直接抛（测试红）。 */
async function runOk(args: string[]): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN; // --help/--version 与凭证无关
  return run(process.execPath, [join(REPO_ROOT, 'deploy/cloudflare/bin.ts'), ...args], { cwd: REPO_ROOT, env });
}

/** 期望 exit 非 0 的运行：把产物带回成功路径统一断言。 */
async function runFail(args: string[]): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  return run(process.execPath, [join(REPO_ROOT, 'deploy/cloudflare/bin.ts'), ...args], { cwd: REPO_ROOT, env }).then(
    (r) => {
      throw new Error(`期望报错退出，实际 exit 0；stdout=${r.stdout.slice(0, 200)}`);
    },
    (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
  );
}

describe('bin.ts 自举冒烟（node 直跑入口）', () => {
  it('无凭证 + 非 TTY：打印 token 第一屏并优雅退出（exit 1、无堆栈）', { timeout: 60_000 }, async () => {
    // 子进程不带 CLOUDFLARE_API_TOKEN；vitest worker 的 stdout 是管道 → isTty()=false → exit 分支
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLOUDFLARE_API_TOKEN;

    const { stdout, stderr } = await run(
      process.execPath,
      [join(REPO_ROOT, 'deploy/cloudflare/bin.ts')],
      {
        cwd: REPO_ROOT,
        env,
        // execFile 默认 maxBuffer 1MB 足够；不 shell —— 与文档启动方式 `node deploy/cloudflare/bin.ts` 同构
      },
    ).catch((error: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => {
      // execFile 对非零退出 reject：把产物带回成功路径统一断言
      expect(error.code, '缺凭证的既定退出码是 1（process.exitCode），非崩溃信号').toBe(1);
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    });

    // 第一屏人话：提示缺 token + 深链接 + export 指引（对齐 interactive.ts buildTokenFirstScreen）
    expect(stdout).toContain('未检测到 CLOUDFLARE_API_TOKEN');
    expect(stdout).toContain('dash.cloudflare.com/profile/api-tokens');
    expect(stdout).toContain('export CLOUDFLARE_API_TOKEN=');
    // 非交互终端的人话：不出现「粘贴仅本次有效」（那是给 TTY 用户的提示）
    expect(stdout).not.toContain('粘贴仅本次有效');

    // 未进入九步：装配器横幅只在拿到凭证后打印
    expect(stdout).not.toContain('幂等九步装配');

    // 优雅退出：stderr 是 main 的一行人话（非交互终端无法粘贴 token），不是异常堆栈
    expect(stderr).toContain('非交互终端无法粘贴 token');
    expect(stderr).not.toMatch(/at .+\(.+:\d+:\d+\)/); // 无堆栈帧 = 自举链路未崩
  });

  it('--help：打印用法后 exit 0，不触发部署（#249）', { timeout: 60_000 }, async () => {
    const { stdout, stderr } = await runOk(['--help']);
    expect(stdout).toContain('用法：node deploy/cloudflare/bin.ts [参数]');
    expect(stdout).toContain('--domain=<域名>');
    expect(stdout).toContain('--version');
    expect(stdout).toContain('CLOUDFLARE_API_TOKEN');
    expect(stderr).toBe('');
    // 短路语义：不读配置、不问 token、不进九步（横幅只在九步前出现）
    expect(stdout).not.toContain('Unself · deploy/cloudflare');
    expect(stdout).not.toContain('未检测到 CLOUDFLARE_API_TOKEN');
    expect(stdout).not.toContain('dash.cloudflare.com');
  });

  it('--version：打印版本号（与 package.json 一致）后 exit 0，不触发部署（#249）', { timeout: 60_000 }, async () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'deploy/cloudflare/package.json'), 'utf8')) as { version: string };
    const { stdout, stderr } = await runOk(['--version']);
    expect(stdout.trim()).toBe(pkg.version);
    expect(stderr).toBe('');
    expect(stdout).not.toContain('Unself · deploy/cloudflare');
  });

  it('--domian=x（拼错）：报错而非静默忽略，exit 1，给 did-you-mean（#249）', { timeout: 60_000 }, async () => {
    const { stdout, stderr } = await runFail(['--domian=x']);
    expect(stderr).toContain('未知参数「--domian=x」');
    expect(stderr).toContain('--domain');
    expect(stderr).toContain('--help');
    // 报错后不得继续装配
    expect(stdout).not.toContain('幂等九步装配');
    expect(stdout).not.toContain('将装配');
  });

  it('裸 --domain（缺等号）：报错指路取值写法，exit 1（#249）', { timeout: 60_000 }, async () => {
    const { stderr } = await runFail(['--domain']);
    expect(stderr).toContain('等号');
  });
});
