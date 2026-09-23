// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import entry, { type ProdEnv } from '../src/entry.prod';

const html = '<!doctype html><html><head></head><body>setup</body></html>';

/** 外部资产服务返回旧 MIME：覆盖真实线上 200 SPA 回退，而非只模拟 404。 */
function fetchAsset(path: string, body: string, status = 200, deepLink404 = false) {
  const env = {
    ASSETS: {
      fetch: async (request: Request) => new Response(body, {
        status: deepLink404 && new URL(request.url).pathname !== '/index.html' ? 404 : status,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    },
  } as unknown as ProdEnv;
  return entry.fetch(new Request('https://team.example.com' + path, {
    headers: { accept: 'text/html' },
  }), env, {} as ExecutionContext);
}

describe('旧 MIME 的生产入口响应', () => {
  it.each([false, true])('setup 资产服务是否先返回 404=%s：都可作为 HTML 打开', async (deepLink404) => {
    const res = await fetchAsset('/setup?token=test', html, 200, deepLink404);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(await res.text()).toBe(html);
  });

  it.each([
    ['/assets/main.js', 'export const ready = true;', 'text/javascript; charset=utf-8'],
    ['/assets/main.css', 'body { color: black }', 'text/css; charset=utf-8'],
    ['/download.bin', 'binary', 'application/octet-stream'],
    ['/assets/image.png', 'image', 'application/octet-stream'],
  ])('%s 保持正文，按资源类型响应而非 Accept', async (path, body, type) => {
    const res = await fetchAsset(path, body);
    expect(res.headers.get('content-type')).toBe(type);
    expect(res.headers.has('content-security-policy')).toBe(false);
    expect(await res.text()).toBe(body);
  });

  it('资产服务失败不伪装为页面成功', async () => {
    const res = await fetchAsset('/setup', 'storage unavailable', 503);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(await res.text()).toBe('storage unavailable');
  });

  it('API 的 404 保持 JSON，不变成页面', async () => {
    const res = await fetchAsset('/api/missing', html);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
