// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HTML 安全响应头的行为测试（决策 #47，M1 复核 S8）。
 * 断言打在「响应上有没有该有的头」——不测源码文本、不测内部调用。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HTML_CSP, HTML_FRAME_OPTIONS, withHtmlSecurityHeaders } from '../src/security-headers';

function html(body = '<!doctype html><html></html>'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

describe('withHtmlSecurityHeaders（HTML 响应补头）', () => {
  it('text/html 响应拿到 CSP / X-Frame-Options / nosniff / Referrer-Policy', async () => {
    const res = await withHtmlSecurityHeaders(html());
    expect(res.headers.get('content-security-policy')).toBe(HTML_CSP);
    expect(res.headers.get('x-frame-options')).toBe(HTML_FRAME_OPTIONS);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('反点击劫持两个方向都在：frame-ancestors 收敛 + X-Frame-Options 兜底', async () => {
    const csp = (await withHtmlSecurityHeaders(html())).headers.get('content-security-policy')!;
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('*');
  });

  it('响应体与状态码原样透传（补头不改内容）', async () => {
    const res = await withHtmlSecurityHeaders(new Response('<h1>hi</h1>', { status: 418, headers: { 'content-type': 'text/html' } }));
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('<h1>hi</h1>');
  });

  it('JSON 响应不被加头（API 不上这套头）', async () => {
    const res = await withHtmlSecurityHeaders(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
    expect(res.headers.has('content-security-policy')).toBe(false);
    expect(res.headers.has('x-frame-options')).toBe(false);
  });

  it('空 content-type / 二进制不被加头', async () => {
    expect((await withHtmlSecurityHeaders(new Response('x'))).headers.has('content-security-policy')).toBe(false);
    expect(
      (
        await withHtmlSecurityHeaders(
          new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } }),
        )
      ).headers.has('content-security-policy'),
    ).toBe(false);
  });

  it('已有同名头时不覆盖（静态资产 _headers 先加过 → 幂等）', async () => {
    const res = await withHtmlSecurityHeaders(
      new Response('<html>', { headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY' } }),
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe(HTML_CSP);
  });
});

describe('两处头值不漂移（_headers 文件 ↔ security-headers.ts）', () => {
  it('app/workbench/web/public/_headers 的 CSP 与 HTML_CSP 逐字一致', async () => {
    const text = await readFile(join(process.cwd(), '../../app/workbench/web/public/_headers'), 'utf8');
    const csp = text.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1]?.trim();
    const frameOptions = text.match(/^\s*X-Frame-Options:\s*(.+)$/m)?.[1]?.trim();
    expect(csp).toBe(HTML_CSP);
    expect(frameOptions).toBe(HTML_FRAME_OPTIONS);
  });
});
