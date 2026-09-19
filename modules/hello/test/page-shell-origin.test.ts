// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import app from '../src/index';

/**
 * #277 模块页 coreOrigin 取值面：
 * workers.dev 形态下模块挂**自有子域**（跨子域 iframe），写死 location.origin 会把模块自己当壳
 * → SDK 入站 token 校验（event.origin === coreOrigin）永远不中 → 浏览器里握手死（HTTP 级看不出来）。
 * 页面内联脚本在 Node 里不可执行（浏览器 ESM），本文件只锁「页面引用 SDK 壳 origin 解析器」；
 * 取值行为（ancestorOrigins / 注入 meta / 直开三场景）由 packages/sdk 行为用例
 * 与真机探针（workers.dev 形态模块页 HTML + 部署后的 SDK 字节）裁决。
 */
describe('module-hello 页面 coreOrigin（#277）', () => {
  it('脚本用 resolveShellOrigin() 取壳 origin，不再把 window.location.origin 当 coreOrigin', async () => {
    const res = await app.request('https://m.example/');
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("import { createModuleSDK, resolveShellOrigin } from './sdk/module-sdk.esm.js'");
    expect(html).toContain('coreOrigin: resolveShellOrigin()');
    // 旧写法（写死自身 origin）不得回归
    expect(html).not.toContain('window.location.origin');
  });
});
