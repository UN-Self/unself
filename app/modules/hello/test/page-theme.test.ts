// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { analyzeTokenUsage } from '@unself/contracts';

import app from '../src/index';

/**
 * 模块页主题体检（§6.5.5 注入双通道 / §6.5.8 验产物不验源码）：
 * 页面只留 var(--unself-*) 引用，值由壳下发（通道 A 同源直注 style#unself-tokens
 * 或通道 B SDK ready 握手），页内禁止任何令牌定义与裸颜色值。
 * 两问检验：故意把内联副本加回去（改坏行为）→ 本组断言红；
 * 只重构类名/布局（行为不变）→ 断言保持绿。（不判 DOM 结构、不判文案。）
 */
describe('module-hello 模块页主题（§6.5）', () => {
  it('无内联令牌定义、无裸色值、全部 var 引用在契约白名单且关键令牌被引用', async () => {
    const res = await app.request('https://m.example/');
    expect(res.status).toBe(200);
    const html = await res.text();

    // a) 无内联令牌定义：只允许 var(--unself-*) 引用，不允许任何 --unself-*: 声明
    expect(html).not.toMatch(/--unself-[a-zA-Z0-9-]+\s*:/);

    // b) 无裸值：页面不得出现 hex 颜色与 rgb() 函数（颜色一律走 var）
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/rgb\(/);

    // c) 全部 var() 引用都在契约白名单（未解析引用 → unknown 红），
    //    且关键令牌（间距/圆角/字号）确实被页面引用——退化为独立皮肤即红。
    const { used, unknown } = analyzeTokenUsage(html);
    expect(unknown).toEqual([]);
    expect(used).toEqual(
      expect.arrayContaining([
        '--unself-space-6',
        '--unself-radius-md',
        '--unself-font-size-base',
      ]),
    );

    // d) 页面仍引用 var(--unself-*)（跟随平台主题，非独立皮肤）
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((name) => name.startsWith('--unself-'))).toBe(true);
  });
});
