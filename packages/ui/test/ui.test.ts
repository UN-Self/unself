// SPDX-License-Identifier: AGPL-3.0-only
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';

import { UButton, UCard, UErrorCard, UInput, USkeleton } from '../src/index';

/**
 * 基元行为断言（G1 清理：原「导出存在性 + UI_VERSION 恒真」已删）：
 * 用 vue/server-renderer 真实 SSR 渲染组件，断言其可观测输出
 * （class 契约、slot 文案、属性透传），而不是只问「模块上有东西」。
 */

describe('@unself/ui 基元 SSR 行为', () => {
  it('UButton：默认渲染 type=button + u-btn/u-btn-primary/u-btn-md，slot 文案出现', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(UButton, null, () => '提交') }),
    );
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    expect(html).toContain('class="u-btn u-btn-primary u-btn-md"');
    expect(html).toContain('提交');
  });

  it('UButton：传 disabled 时按钮带 disabled 属性', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(UButton, { disabled: true }, () => '禁用') }),
    );
    expect(html).toMatch(/<button[^>]*\bdisabled\b/);
  });

  it('UButton：variant="outline" 时 class 含 u-btn-outline', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(UButton, { variant: 'outline' }, () => '边框') }),
    );
    expect(html).toContain('class="u-btn u-btn-outline u-btn-md"');
  });

  it('UErrorCard：title 与「请求编号：<requestId>」透传展示', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () => h(UErrorCard, { title: '同步失败', requestId: 'req-7a1' }),
      }),
    );
    expect(html).toContain('同步失败');
    expect(html).toContain('请求编号：req-7a1');
  });

  it('UErrorCard：传 detail 时出现「技术详情」按钮（默认折叠）', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () => h(UErrorCard, { title: '同步失败', detail: 'stack trace' }),
      }),
    );
    expect(html).toContain('技术详情');
    expect(html).toContain('aria-expanded="false"');
  });

  it('UInput：label/placeholder 呈现，error 时 u-input-error 且错误文案可见', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(UInput, { label: '关键词', placeholder: '搜点东西', error: '不能为空' }),
      }),
    );
    expect(html).toContain('关键词');
    expect(html).toContain('placeholder="搜点东西"');
    expect(html).toContain('u-input-error');
    expect(html).toContain('不能为空');
  });

  it('UButton：loading 时按钮带 aria-busy（#83 无障碍补齐）', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(UButton, { loading: true }, () => '提交中') }),
    );
    expect(html).toContain('aria-busy="true"');
  });

  it('UInput：type=email 透传；label for 与 input id 一致（#83 useId 替代随机数）', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(UInput, { label: '邮箱', type: 'email' }) }),
    );
    expect(html).toContain('type="email"');
    const forMatch = /<label[^>]*\bfor="([^"]+)"/.exec(html);
    expect(forMatch).not.toBeNull();
    expect(html).toContain(`id="${forMatch![1]}"`);
  });

  it('USkeleton：行数与末行缩短按 props 生效（#83 收编壳内两处手写骨架）', async () => {
    const three = await renderToString(
      createSSRApp({ render: () => h(USkeleton, { lines: 3 }) }),
    );
    expect(three.match(/u-skeleton-line/g)?.length).toBeGreaterThanOrEqual(3);
    expect(three).toContain('u-skeleton-line-short');
    expect(three).toContain('aria-busy="true"');

    const noShort = await renderToString(
      createSSRApp({ render: () => h(USkeleton, { lines: 2, shortenLast: false }) }),
    );
    expect(noShort).not.toContain('u-skeleton-line-short');
  });

  it('UCard：默认 padding=md 输出 u-card u-card-md 且 slot 内容呈现', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(UCard, null, () => '卡片内容') }),
    );
    expect(html).toContain('class="u-card u-card-md"');
    expect(html).toContain('卡片内容');
  });
});
