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
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/** 仓库根（本文件在 deploy/cloudflare/test/ 下，上三级）。 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

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
});
