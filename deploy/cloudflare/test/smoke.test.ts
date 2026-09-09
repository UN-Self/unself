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
import { checkModuleThemes, smokeCheck } from '../src/smoke';

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

describe('checkModuleThemes（部署期主题体检 · §6.5.8 验产物，不验源码）', () => {
  it('URL 形态 = <baseUrl>/m/<id>/（模块页根路径，与用户实际加载相同）', async () => {
    const captured: string[] = [];
    const m = stubFetch(async (input) => {
      captured.push(String(input));
      return new Response('<html>ok</html>');
    });
    const results = await checkModuleThemes({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(m).toHaveBeenCalledTimes(1);
    expect(captured).toEqual(['https://demo.handywote.top/m/hello/']);
    expect(results.map((r) => r.name)).toEqual(['module:hello']);
  });

  it('HTML 只用白名单 var（var(--unself-color-primary)/var(--unself-space-4)）→ ok:true、skinned:false、unknown=[]', async () => {
    stubFetch(async () =>
      new Response(`<html><body><div style="color: var(--unself-color-primary); margin: var(--unself-space-4)">x</div></body></html>`),
    );
    const results = await checkModuleThemes({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results).toEqual([
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/', ok: true, skinned: false, unknown: [] },
    ]);
  });

  it('HTML 含 var(--color-primary) 或 var(--unself-space4)（未解析）→ ok:false 且 unknown 列出', async () => {
    stubFetch(async () =>
      new Response(`<style>a { color: var(--color-primary); margin: var(--unself-space4); }</style>`),
    );
    const results = await checkModuleThemes({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results[0]).toMatchObject({
      name: 'module:hello',
      url: 'https://demo.handywote.top/m/hello/',
      ok: false,
      skinned: false,
    });
    expect(results[0]?.unknown).toEqual(['--color-primary', '--unself-space4']);
    expect(results[0]?.detail).toBeUndefined();
  });

  it('零 --unself-* 引用（独立皮肤）→ ok:true、skinned:true、unknown=[]（标注不红）', async () => {
    stubFetch(async () => new Response('<html><body><p>独立皮肤自带样式</p></body></html>'));
    const results = await checkModuleThemes({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results).toEqual([
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/', ok: true, skinned: true, unknown: [] },
    ]);
  });

  it('fetch 抛错（网络不可达）→ ok:false、skinned=false、unknown=[]、detail 以「不可达：」开头', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const results = await checkModuleThemes({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results).toEqual([
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/', ok: false, skinned: false, unknown: [], detail: expect.stringMatching(/^不可达：/) },
    ]);
  });

  it('多模块：按 moduleIds 顺序逐页体检，一页失败（未解析令牌）不影响其它页收集', async () => {
    stubFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/m/todo/')) return new Response('<style>a{color:var(--unsafe-color)}</style>');
      return new Response('<style>a{color:var(--unself-color-primary)}</style>');
    });
    const results = await checkModuleThemes({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello', 'todo'] });
    expect(results.map((r) => r.name)).toEqual(['module:hello', 'module:todo']);
    expect(results[0]).toMatchObject({ ok: true, skinned: false, unknown: [] });
    expect(results[1]).toMatchObject({ ok: false, skinned: false });
    expect(results[1]?.unknown).toEqual(['--unsafe-color']);
  });
});
