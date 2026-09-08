// SPDX-License-Identifier: AGPL-3.0-only
/**
 * smokeCheck（§5.3 单域名路径制）行为测试。
 * 只 stub 网络层（vi.stubGlobal('fetch', ...)）捕获请求 URL，真实调用 src/smoke.ts 的 smokeCheck：
 * - URL 形态：domain 与 workers.dev 两种 baseUrl 均走 <baseUrl>/api/health 与 <baseUrl>/m/<id>/api/health
 *   （无 <id>. 子域分支），core 在前、模块按 moduleIds 顺序；
 * - 行为：200+ok:true、200 缺 ok:true（detail「响应体缺 ok:true」）、非 200（detail「HTTP 503」且不解析 JSON）、
 *   fetch 抛错（detail 以「不可达：」开头、status=0）、多模块混合按 moduleIds 顺序返回且失败项不影响成功项。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { smokeCheck } from '../src/smoke';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(
  impl: (input: Parameters<typeof fetch>[0]) => Promise<Response>,
): Mock<(input: Parameters<typeof fetch>[0]) => Promise<Response>> {
  const m = vi.fn(impl);
  vi.stubGlobal('fetch', m);
  return m;
}

describe('smokeCheck 请求 URL 形态（§5.3 单域名路径制）', () => {
  it('domain 模式：core 在前，模块按 moduleIds 顺序，均拼在 baseUrl 后', async () => {
    const captured: string[] = [];
    const m = stubFetch(async (input) => {
      captured.push(String(input));
      return jsonResponse(200, { ok: true });
    });
    const results = await smokeCheck({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(m).toHaveBeenCalledTimes(2);
    expect(captured).toEqual([
      'https://demo.handywote.top/api/health',
      'https://demo.handywote.top/m/hello/api/health',
    ]);
    expect(results.map((r) => r.name)).toEqual(['core-api', 'module:hello']);
  });

  it('workers.dev 模式：三个请求全部同 host 路径制，无 <id>. 子域分支', async () => {
    const captured: string[] = [];
    stubFetch(async (input) => {
      captured.push(String(input));
      return jsonResponse(200, { ok: true });
    });
    await smokeCheck({
      baseUrl: 'https://unself-core-api.test-subdomain.workers.dev',
      moduleIds: ['hello', 'meet'],
    });
    expect(captured).toEqual([
      'https://unself-core-api.test-subdomain.workers.dev/api/health',
      'https://unself-core-api.test-subdomain.workers.dev/m/hello/api/health',
      'https://unself-core-api.test-subdomain.workers.dev/m/meet/api/health',
    ]);
  });
});

describe('smokeCheck 行为断言', () => {
  it('200 且 body {ok:true}：每项 ok=true、status=200、detail 缺省', async () => {
    stubFetch(async () => jsonResponse(200, { ok: true }));
    const results = await smokeCheck({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: true, status: 200, detail: undefined },
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/api/health', ok: true, status: 200, detail: undefined },
    ]);
  });

  it('200 但 body 缺 ok:true（{}）：ok=false，detail 恰为「响应体缺 ok:true」', async () => {
    stubFetch(async () => jsonResponse(200, {}));
    const results = await smokeCheck({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: false, status: 200, detail: '响应体缺 ok:true' },
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/api/health', ok: false, status: 200, detail: '响应体缺 ok:true' },
    ]);
  });

  it('非 200（503）：ok=false、status=503、detail「HTTP 503」，且不尝试解析 JSON', async () => {
    const jsonSpy = vi.fn(async () => {
      throw new Error('非 200 分支不应调用 res.json()');
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 503, json: jsonSpy }) as unknown as Response));
    const results = await smokeCheck({ baseUrl: 'https://demo.handywote.top', moduleIds: [] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: false, status: 503, detail: 'HTTP 503' },
    ]);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('fetch 抛错（网络不可达）：ok=false、status=0、detail 以「不可达：」开头', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const results = await smokeCheck({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: false, status: 0, detail: expect.stringMatching(/^不可达：/) },
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/api/health', ok: false, status: 0, detail: expect.stringMatching(/^不可达：/) },
    ]);
  });

  it('多模块混合：一项成功一项失败，返回数组按 moduleIds 顺序且失败项不影响成功项', async () => {
    stubFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/m/meet/api/health')) return jsonResponse(503, { error: 'boom' });
      return jsonResponse(200, { ok: true });
    });
    const results = await smokeCheck({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello', 'meet'] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: true, status: 200, detail: undefined },
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/api/health', ok: true, status: 200, detail: undefined },
      { name: 'module:meet', url: 'https://demo.handywote.top/m/meet/api/health', ok: false, status: 503, detail: 'HTTP 503' },
    ]);
  });
});
