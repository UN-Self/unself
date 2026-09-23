// SPDX-License-Identifier: AGPL-3.0-only
/**
 * smoke（§5.3 单域名路径制）行为测试（#244 REST 化后）：
 * - smokeCheck / checkModuleThemes：stub 网络层，守 URL 形态与成败判定；
 * - generateSetupToken：24B → 32 字符 base64url 随机性；
 * - issueSetupToken 三态（created/reused/sealed）：经 ControlPlane-over-sqlite 直测（#244 迁出 wrangler）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkModuleThemes, generateSetupToken, smokeCheck } from '../../src/engine/smoke';
import { SqliteControlPlane } from '@unself/control-plane';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(
  impl: (input: Parameters<typeof fetch>[0]) => Promise<Response>,
) {
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
    const results = await smokeCheck({ coreUrl: 'https://demo.handywote.top', modules: [{ id: 'hello', baseUrl: 'https://demo.handywote.top/m/hello' }] });
    expect(m).toHaveBeenCalledTimes(2);
    expect(captured).toEqual([
      'https://demo.handywote.top/api/health',
      'https://demo.handywote.top/m/hello/api/health',
    ]);
    expect(results.map((r) => r.name)).toEqual(['core-api', 'module:hello']);
  });

  it('workers.dev 模式：core 探 core 子域，模块各自探**自有**子域（#273，不再拼 core 的 /m/<id>）', async () => {
    const captured: string[] = [];
    stubFetch(async (input) => {
      captured.push(String(input));
      return jsonResponse(200, { ok: true });
    });
    await smokeCheck({
      coreUrl: 'https://unself-workbench.test-subdomain.workers.dev',
      modules: [
        { id: 'hello', baseUrl: 'https://unself-module-hello.test-subdomain.workers.dev' },
        { id: 'meet', baseUrl: 'https://unself-module-meet.test-subdomain.workers.dev' },
      ],
    });
    expect(captured).toEqual([
      'https://unself-workbench.test-subdomain.workers.dev/api/health',
      'https://unself-module-hello.test-subdomain.workers.dev/api/health',
      'https://unself-module-meet.test-subdomain.workers.dev/api/health',
    ]);
  });

  it('模块不可达（自有子域不存在）→ 真红，不静默跳过（#273 硬要求）', async () => {
    stubFetch(async (input) => {
      const url = String(input);
      if (url.includes('unself-module-hello')) throw new TypeError('fetch failed');
      return jsonResponse(200, { ok: true });
    });
    const results = await smokeCheck({
      coreUrl: 'https://unself-workbench.test-subdomain.workers.dev',
      modules: [{ id: 'hello', baseUrl: 'https://unself-module-hello.test-subdomain.workers.dev' }],
    });
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({
      name: 'module:hello',
      url: 'https://unself-module-hello.test-subdomain.workers.dev/api/health',
      ok: false,
      status: 0,
    });
  });
});

describe('smokeCheck 行为断言', () => {
  it.each(['core-api', 'workbench'])('真实装配校验壳身份：%s', async service => {
    stubFetch(async input => String(input).endsWith('/api/health')
      ? jsonResponse(200, { ok: true, service })
      : new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const results = await smokeCheck({ coreUrl: 'https://team.example.com', modules: [], verifyWorkbench: true });
    expect(results[0]?.ok).toBe(service === 'workbench');
    expect(results.slice(1).every(r => r.ok)).toBe(true);
  });

  it.each([
    ['application/octet-stream', '', false],
    ['text/html', 'attachment; filename=login', false],
    ['text/html; charset=utf-8', '', true],
  ])('导航响应 %s / %s 必须能作为页面打开', async (type, disposition, ok) => {
    stubFetch(async input => String(input).endsWith('/api/health')
      ? jsonResponse(200, { ok: true, service: 'workbench' })
      : new Response('<!doctype html><html></html>', { headers: { 'content-type': String(type), 'content-disposition': String(disposition) } }));
    const results = await smokeCheck({ coreUrl: 'https://team.example.com', modules: [], verifyWorkbench: true });
    expect(results).toHaveLength(3);
    expect(results.slice(1).map(r => r.ok)).toEqual([ok, ok]);
  });
  it('200 且 body {ok:true}：每项 ok=true、status=200、detail 缺省', async () => {
    stubFetch(async () => jsonResponse(200, { ok: true }));
    const results = await smokeCheck({ coreUrl: 'https://demo.handywote.top', modules: [{ id: 'hello', baseUrl: 'https://demo.handywote.top/m/hello' }] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: true, status: 200, detail: undefined },
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/api/health', ok: true, status: 200, detail: undefined },
    ]);
  });

  it('200 但 body 缺 ok:true（{}）：ok=false，detail 恰为「响应体缺 ok:true」', async () => {
    stubFetch(async () => jsonResponse(200, {}));
    const results = await smokeCheck({ coreUrl: 'https://demo.handywote.top', modules: [{ id: 'hello', baseUrl: 'https://demo.handywote.top/m/hello' }] });
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
    const results = await smokeCheck({ coreUrl: 'https://demo.handywote.top', modules: [] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: false, status: 503, detail: 'HTTP 503' },
    ]);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('fetch 抛错（网络不可达）：ok=false、status=0、detail 以「不可达：」开头', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const results = await smokeCheck({ coreUrl: 'https://demo.handywote.top', modules: [{ id: 'hello', baseUrl: 'https://demo.handywote.top/m/hello' }] });
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
    const results = await smokeCheck({ coreUrl: 'https://demo.handywote.top', modules: [{ id: 'hello', baseUrl: 'https://demo.handywote.top/m/hello' }, { id: 'meet', baseUrl: 'https://demo.handywote.top/m/meet' }] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: true, status: 200, detail: undefined },
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/api/health', ok: true, status: 200, detail: undefined },
      { name: 'module:meet', url: 'https://demo.handywote.top/m/meet/api/health', ok: false, status: 503, detail: 'HTTP 503' },
    ]);
  });
});

describe('步骤⑧ 本地签发（#165 方案 B：ControlPlane 直签）', () => {
  it('generateSetupToken：24B → 32 字符 base64url（URL 安全、无填充、两次不同）', () => {
    const a = generateSetupToken();
    const b = generateSetupToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });

  it('未封箱且无既有 token：created + INSERT 写入；再问 reuse', async () => {
    const cp = SqliteControlPlane.open(':memory:');
    const first = await cp.issueSetupToken(generateSetupToken);
    expect(first.status).toBe('created');
    expect(first.status === 'created' && first.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const again = await cp.issueSetupToken(generateSetupToken);
    expect(again.status).toBe('reused');
    const againToken = again.status === 'reused' ? again.token : '';
    expect(againToken === (first.status === 'created' ? first.token : '')).toBe(true);
  });

  it('已封箱：sealed 且不签发（setup_done=1 后）', async () => {
    const cp = SqliteControlPlane.open(':memory:');
    cp.db.exec("INSERT INTO instance_config (key, value) VALUES ('setup_done', '1')");
    const result = await cp.issueSetupToken(generateSetupToken);
    expect(result).toEqual({ status: 'sealed' });
  });
});

describe('checkModuleThemes（部署期主题体检 · §6.5.8 验产物，不验源码）', () => {
  it('URL 形态 = <moduleBaseUrl>/（模块页根路径，与用户实际加载相同；domain 形态基址含 /m/<id>）', async () => {
    const captured: string[] = [];
    const m = stubFetch(async (input) => {
      captured.push(String(input));
      return new Response('<html>ok</html>');
    });
    const results = await checkModuleThemes({ modules: [{ id: 'hello', baseUrl: 'https://demo.handywote.top/m/hello' }] });
    expect(m).toHaveBeenCalledTimes(1);
    expect(captured).toEqual(['https://demo.handywote.top/m/hello/']);
    expect(results.map((r) => r.name)).toEqual(['module:hello']);
  });

  it('workers.dev 形态：主题体检探模块自有子域根路径（#273）', async () => {
    const captured: string[] = [];
    stubFetch(async (input) => {
      captured.push(String(input));
      return new Response('<html>ok</html>');
    });
    await checkModuleThemes({
      modules: [{ id: 'hello', baseUrl: 'https://unself-module-hello.test-subdomain.workers.dev' }],
    });
    expect(captured).toEqual(['https://unself-module-hello.test-subdomain.workers.dev/']);
  });

  it('HTML 只用白名单 var（var(--unself-color-primary)/var(--unself-space-4)）→ ok:true、skinned:false、unknown=[]', async () => {
    stubFetch(async () =>
      new Response(`<html><body><div style="color: var(--unself-color-primary); margin: var(--unself-space-4)">x</div></body></html>`),
    );
    const results = await checkModuleThemes({ modules: [{ id: 'hello', baseUrl: 'https://demo.handywote.top/m/hello' }] });
    expect(results).toEqual([
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/', ok: true, skinned: false, unknown: [] },
    ]);
  });

  it('HTML 含 var(--color-primary) 或 var(--unself-space4)（未解析）→ ok:false 且 unknown 列出', async () => {
    stubFetch(async () =>
      new Response(`<style>a { color: var(--color-primary); margin: var(--unself-space4); }</style>`),
    );
    const results = await checkModuleThemes({ modules: [{ id: 'hello', baseUrl: 'https://demo.handywote.top/m/hello' }] });
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
    const results = await checkModuleThemes({ modules: [{ id: 'hello', baseUrl: 'https://demo.handywote.top/m/hello' }] });
    expect(results).toEqual([
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/', ok: true, skinned: true, unknown: [] },
    ]);
  });

  it('fetch 抛错（网络不可达）→ ok:false、skinned=false、unknown=[]、detail 以「不可达：」开头', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const results = await checkModuleThemes({ modules: [{ id: 'hello', baseUrl: 'https://demo.handywote.top/m/hello' }] });
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
    const results = await checkModuleThemes({ modules: [{ id: 'hello', baseUrl: 'https://demo.handywote.top/m/hello' }, { id: 'todo', baseUrl: 'https://demo.handywote.top/m/todo' }] });
    expect(results.map((r) => r.name)).toEqual(['module:hello', 'module:todo']);
    expect(results[0]).toMatchObject({ ok: true, skinned: false, unknown: [] });
    expect(results[1]).toMatchObject({ ok: false, skinned: false });
    expect(results[1]?.unknown).toEqual(['--unsafe-color']);
  });
});

