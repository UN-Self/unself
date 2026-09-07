// SPDX-License-Identifier: AGPL-3.0-only
/**
 * wrangler 执行器：所有对 wrangler CLI 的调用走此接口，
 * 单元测试注入录制型 fake（#14 验收：连跑两次收敛即对同一 fake 状态重放）。
 */
import { spawn } from 'node:child_process';

/** 一次 wrangler 子命令调用的结果。 */
export interface ExecResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export class WranglerError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly result: ExecResult,
  ) {
    super(`${message}\n  命令: wrangler ${args.join(' ')}\n  stderr: ${result.stderr.slice(0, 2000)}`);
    this.name = 'WranglerError';
  }
}

/** wrangler 执行器接口（真实 = spawn 本机 wrangler；测试 = fake）。 */
export interface Wrangler {
  /** 执行 `wrangler <args...>`；非零退出抛 WranglerError（除非 expectFailure）。 */
  run(args: string[], opts?: { silent?: boolean }): Promise<ExecResult>;
  /** 允许失败的执行（如 d1 list 探测），返回原始结果。 */
  tryRun(args: string[]): Promise<ExecResult>;
}

/** 真实执行器：仓库根 cwd 下 spawn wrangler（参数数组，不走 shell）。 */
export function realWrangler(rootDir: string, bin = 'wrangler'): Wrangler {
  const exec = (args: string[]): Promise<ExecResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: rootDir,
        shell: false,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({ ok: code === 0, code: code ?? -1, stdout, stderr }),
      );
    });
  return {
    async run(args, opts) {
      if (!opts?.silent) console.log(`  $ wrangler ${args.join(' ')}`);
      const result = await exec(args);
      if (!result.ok) {
        throw new WranglerError('wrangler 命令失败', args, result);
      }
      return result;
    },
    async tryRun(args) {
      return exec(args);
    },
  };
}
