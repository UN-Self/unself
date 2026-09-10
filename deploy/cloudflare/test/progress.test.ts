// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { progressTracker } from '../src/progress';

describe('progressTracker（runNineSteps 九步进度适配）', () => {
  it('成功序：[1/9]…… → [2/9]……（上一步闭合 ✓）→ complete() 闭合末步 ✓', () => {
    const out: string[] = [];
    const t = progressTracker({ total: 9, out: (l) => out.push(l) });
    t.reporter.step(1, '确保 D1');
    t.reporter.log('unself-core 已存在（跳过）');
    t.reporter.step(2, '跑迁移');
    t.complete();
    expect(out).toEqual([
      '[1/9] 确保 D1……',
      '  unself-core 已存在（跳过）',
      '[1/9] 确保 D1 ✓',
      '[2/9] 跑迁移……',
      '[2/9] 跑迁移 ✓',
    ]);
  });

  it('失败：当前步 ✗ + 三要素（原因/归属/修复）', () => {
    const out: string[] = [];
    const t = progressTracker({ total: 9, out: (l) => out.push(l) });
    t.reporter.step(5, '部署模块');
    t.fail(new Error('wrangler 命令失败\n  stderr: [code: 10405] Authentication error'));
    expect(out).toEqual([
      '[5/9] 部署模块……',
      '[5/9] 部署模块 ✗',
      '  原因：stderr: [code: 10405] Authentication error',
      '  归属：你的 token 权限',
      '  修复：你的 token 缺 Zone 级权限：用第一屏的深链接重建 token（勾选 Workers Routes / DNS / SSL and Certificates），然后重跑本命令',
    ]);
  });

  it('失败在步骤间（current=null）只打三要素', () => {
    const out: string[] = [];
    const t = progressTracker({ total: 9, out: (l) => out.push(l) });
    t.fail(new Error('boom'));
    expect(out).toEqual(['  原因：boom', '  归属：代码/配置', '  修复：直接重跑同一条命令即可：装配器幂等收敛，不会重复创建资源']);
  });
});
