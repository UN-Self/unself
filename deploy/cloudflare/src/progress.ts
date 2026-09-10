// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 九步进度包装（PRODUCT_SPEC §5.5 ④）：runNineSteps 是整包九步（rep.step(n, title)
 * 标记步开始），本适配器据其事件输出 `[i/9] 步骤名……`，下一步开始或整包完成时给
 * 上一步补 ✓；失败时给当前步 ✗ + 三要素（原因/归属/修复，errors.advise）。
 * 编排语义零改动（steps.ts 不动，既有 88 例不红），包装只管输出。
 */
import { advise, formatAdvice } from './errors';
import type { StepReporter } from './steps';

export type ProgressOutput = (line: string) => void;

export interface ProgressTracker {
  /** 传给 runNineSteps 的 reporter。 */
  reporter: StepReporter;
  /** 整包成功：闭合最后一步 ✓。 */
  complete(): void;
  /** 整包失败：当前步 ✗ + 三要素行。错误本身由调用方 rethrow。 */
  fail(err: unknown): void;
}

export function progressTracker(input: { total: number; out: ProgressOutput }): ProgressTracker {
  const { total, out } = input;
  let current: { n: number; title: string } | null = null;
  const okLine = (s: { n: number; title: string }) => out(`[${s.n}/${total}] ${s.title} ✓`);
  return {
    reporter: {
      step(n: number, title: string) {
        if (current) okLine(current);
        out(`[${n}/${total}] ${title}……`);
        current = { n, title };
      },
      log(msg: string) {
        out(`  ${msg}`);
      },
    },
    complete() {
      if (current) okLine(current);
      current = null;
    },
    fail(err: unknown) {
      if (current) out(`[${current.n}/${total}] ${current.title} ✗`);
      for (const line of formatAdvice(advise(err))) out(line);
      current = null;
    },
  };
}
