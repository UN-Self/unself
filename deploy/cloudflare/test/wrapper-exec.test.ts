// SPDX-License-Identifier: AGPL-3.0-only
/**
 * wrapper 前缀剥除的行为测试（#193 T5）：把 prefixStripWrapperSource 产物写进临时目录，
 * 连同假 app.js（记录型 worker）一起真实 import 执行——断言打在「请求经 wrapper 后
 * 到了哪、带了什么」，不再只对源码文本做 toContain 弱断言。
 *
 * 假 ASSETS：记录请求并按需回 200/404；假 worker：记录重写后的 URL/method/body。
 * 全部走真实 fetch(request, env, ctx) 调用约定（与 core 入口同款）。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { prefixStripWrapperSource } from '../src/assemble';

interface AssetCall {
  url: string;
  method: string;
}

interface WorkerCall {
  pathname: string;
  method: string;
  /** body 文本（POST 场景）；无 body 为 null。 */
  body: string | null;
}

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) {
    await rm(temps.pop()!, { recursive: true, force: true });
  }
});

/** 装配一个可执行的 wrapper 模块：假 ASSETS（命中表驱动）+ 假 worker（记录型，闭包通道）。 */
async function loadWrapper(options: {
  moduleId: string;
  /** 挂载前缀：缺省 `/m/<id>`（domain 形态）；'' = 根挂载（workers.dev 形态，#273）。 */
  mount?: string;
  /** 壳 origin（frame-ancestors 值）；缺省 undefined = 不发该头。 */
  shellOrigin?: string | null;
  /** 请求基原点（worker.dev 形态用模块自有子域）。缺省 team.example.com。 */
  origin?: string;
  /** ASSETS.fetch 命中表：路径 → 响应体（未列出 = 404）。 */
  assets?: Record<string, string>;
  /** ASSETS.fetch 命中表：路径 → 完整 ResponseInit（status/headers，含 content-type；#277 注入判定用）。 */
  assetInits?: Record<string, ResponseInit>;
  /** 假 worker 响应开关（#277）：'json'（缺省，现有断言不变）或 'html'（回落 worker 渲染模块页场景）。 */
  workerResponse?: 'json' | 'html';
}): Promise<{
  assetCalls: AssetCall[];
  workerCalls: WorkerCall[];
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'unself-wrapper-'));
  temps.push(dir);

  await writeFile(
    join(dir, 'recorder.mjs'),
    `export const recorder = { assetCalls: [], workerCalls: [] };
`,
  );
  // 假 worker：从 recorder.mjs 取记录通道（worker.js 与 app.js 共享同一 ESM 模块实例）
  // #277：workerResponse='html' 时假 worker 返回 text/html（模拟 Hono 渲染模块页），缺省 json 不变
  const workerResponseKind = options.workerResponse ?? 'json';
  const workerResponseContentType = workerResponseKind === 'html' ? 'text/html; charset=utf-8' : 'application/json';
  const workerBodyExpr = workerResponseKind === 'html'
    ? JSON.stringify('<!doctype html><html><head><title>module</title></head><body>worker page</body></html>')
    : `JSON.stringify({ worker: true, pathname: url.pathname })`;
  await writeFile(
    join(dir, 'app.js'),
    `import { recorder } from './recorder.mjs';
export default {
  async fetch(request) {
    const url = new URL(request.url);
    let body = null;
    if (request.body) {
      const chunks = [];
      for await (const chunk of request.body) chunks.push(chunk);
      body = Buffer.concat(chunks).toString('utf8');
    }
    recorder.workerCalls.push({ pathname: url.pathname, method: request.method, body });
    return new Response(${workerBodyExpr}, { status: 200, headers: { 'content-type': '${workerResponseContentType}' } });
  },
};
`,
  );
  await writeFile(join(dir, 'worker.js'), prefixStripWrapperSource(options.moduleId, {
    mount: options.mount ?? `/m/${options.moduleId}`,
    shellOrigin: options.shellOrigin ?? null,
  }));

  const { recorder } = await import(pathToFileURL(join(dir, 'recorder.mjs')).href);

  const assetsTable = options.assets ?? {};
  const assetInits = options.assetInits ?? {};
  const fakeAssets = {
    fetch: async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      recorder.assetCalls.push({ url: url.pathname, method: 'GET' });
      const body = assetsTable[url.pathname];
      if (body === undefined) return new Response('not found', { status: 404 });
      // init 由测试方给（content-type/status 驱动 #277 注入判定）；缺省沿用原 200 无头行为
      const init = assetInits[url.pathname] ?? { status: 200 };
      // undici：101/204/205/304 禁 body → null 构造（与真实 ASSETS 行为一致：无 body 状态无流）
      if ([101, 204, 205, 304].includes(init.status ?? 200)) return new Response(null, init);
      return new Response(body, init);
    },
  };

  const mod = await import(pathToFileURL(join(dir, 'worker.js')).href);
  return {
    assetCalls: recorder.assetCalls as AssetCall[],
    workerCalls: recorder.workerCalls as WorkerCall[],
    fetch: (path: string, init?: RequestInit) =>
      mod.default.fetch(
        new Request(`${options.origin ?? 'https://team.example.com'}${path}`, init),
        { ASSETS: fakeAssets },
        { waitUntil: () => {}, passThroughOnException: () => {} },
      ),
  };
}

describe('prefixStripWrapper 真实执行（资产分支 / 预取 / duplex，T5）', () => {
  it('资产请求（/m/hello/sdk/x.js）：isAsset 判定成立 → ASSETS 收到剥前缀路径，worker 不被调用', async () => {
    const w = await loadWrapper({ moduleId: 'hello', assets: { '/sdk/x.js': '// sdk' } });
    const res = await w.fetch('/m/hello/sdk/x.js');
    expect(res.status).toBe(200);
    // ASSETS 命中表查的是剥前缀后的路径：前缀剥除真实发生
    expect(w.assetCalls).toEqual([{ url: '/sdk/x.js', method: 'GET' }]);
    expect(w.workerCalls).toHaveLength(0);
  });

  it('模块页根路径（/m/hello/）：isAsset 排除前缀本身 → 预取 /index.html 命中即返回，worker 不被调用', async () => {
    const w = await loadWrapper({ moduleId: 'hello', assets: { '/index.html': '<html>module page</html>' } });
    const res = await w.fetch('/m/hello/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('module page');
    // 预取的是根 /index.html（部署期静态资产），不是 /m/hello/index.html
    expect(w.assetCalls).toEqual([{ url: '/index.html', method: 'GET' }]);
    expect(w.workerCalls).toHaveLength(0);
  });

  it('根路径预取 404（模块无静态 index.html）→ 回落 worker（渲染模块页），worker 看到剥前缀后的 /', async () => {
    const w = await loadWrapper({ moduleId: 'hello', assets: {} });
    const res = await w.fetch('/m/hello/');
    expect(res.status).toBe(200);
    expect(w.assetCalls).toEqual([{ url: '/index.html', method: 'GET' }]);
    expect(w.workerCalls).toEqual([{ pathname: '/', method: 'GET', body: null }]);
  });

  it('API 请求（POST /m/hello/api/data 带流式 body）：非资产 → body 经 duplex 透传到 worker，路径已剥前缀', async () => {
    const w = await loadWrapper({ moduleId: 'hello' });
    const res = await w.fetch('/m/hello/api/data', {
      method: 'POST',
      body: '{"hello":"world"}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    // worker 收到：剥前缀路径 + 原方法 + 完整 body（duplex:'half' 重建 Request 后流式可读）
    expect(w.workerCalls).toEqual([
      { pathname: '/api/data', method: 'POST', body: '{"hello":"world"}' },
    ]);
    // ASSETS 完全未被触碰（API 不是资产）
    expect(w.assetCalls).toHaveLength(0);
  });

  it('非 GET（POST 到资产形路径）不走资产分支：isAsset 判定含 method === GET', async () => {
    const w = await loadWrapper({ moduleId: 'hello', assets: { '/sdk/x.js': '// sdk' } });
    const res = await w.fetch('/m/hello/sdk/x.js', { method: 'POST', body: 'x' });
    expect(res.status).toBe(200);
    expect(w.assetCalls).toHaveLength(0);
    expect(w.workerCalls).toEqual([{ pathname: '/sdk/x.js', method: 'POST', body: 'x' }]);
  });

  it('/life/ 生命周期路径不走资产分支（与 /api/ 同权）', async () => {
    const w = await loadWrapper({ moduleId: 'hello', assets: { '/life/x': 'asset?' } });
    await w.fetch('/m/hello/life/x');
    expect(w.assetCalls).toHaveLength(0);
    expect(w.workerCalls).toEqual([{ pathname: '/life/x', method: 'GET', body: null }]);
  });
});

describe('wrapper 形态化（#273）：workers.dev 根挂载 + 模块侧 frame-ancestors', () => {
  const MODULE_ORIGIN = 'https://unself-module-hello.test-subdomain.workers.dev';

  it('根挂载（mount=""）：/sdk/x.js 原路径命中 ASSETS，worker 不被调用', async () => {
    const w = await loadWrapper({ moduleId: 'hello', mount: '', origin: MODULE_ORIGIN, assets: { '/sdk/x.js': '// sdk' } });
    const res = await w.fetch('/sdk/x.js');
    expect(res.status).toBe(200);
    expect(w.assetCalls).toEqual([{ url: '/sdk/x.js', method: 'GET' }]);
    expect(w.workerCalls).toHaveLength(0);
  });

  it('根挂载：/api/health 不剥前缀，worker 收到原路径（真实 URL 就是根挂载）', async () => {
    const w = await loadWrapper({ moduleId: 'hello', mount: '', origin: MODULE_ORIGIN });
    await w.fetch('/api/health');
    expect(w.workerCalls).toEqual([{ pathname: '/api/health', method: 'GET', body: null }]);
    expect(w.assetCalls).toHaveLength(0);
  });

  it('根挂载：/ 预取 /index.html 命中即返回，worker 不被调用', async () => {
    const w = await loadWrapper({ moduleId: 'hello', mount: '', origin: MODULE_ORIGIN, assets: { '/index.html': '<html>module</html>' } });
    const res = await w.fetch('/');
    expect(await res.text()).toContain('module');
    expect(w.assetCalls).toEqual([{ url: '/index.html', method: 'GET' }]);
    expect(w.workerCalls).toHaveLength(0);
  });

  it('domain 挂载 + shellOrigin：模块响应带 CSP frame-ancestors = 壳 origin（决策 #63）', async () => {
    const w = await loadWrapper({ moduleId: 'hello', shellOrigin: 'https://demo.handywote.top' });
    const res = await w.fetch('/m/hello/');
    expect(res.headers.get('content-security-policy')).toBe('frame-ancestors https://demo.handywote.top');
  });

  it('workers.dev 根挂载 + shellOrigin：模块响应带 frame-ancestors = core 子域 origin（跨子域 iframe 放行）', async () => {
    const w = await loadWrapper({
      moduleId: 'hello',
      mount: '',
      origin: MODULE_ORIGIN,
      shellOrigin: 'https://unself-core-api.test-subdomain.workers.dev',
    });
    const res = await w.fetch('/');
    expect(res.headers.get('content-security-policy')).toBe(
      'frame-ancestors https://unself-core-api.test-subdomain.workers.dev',
    );
  });

  it('shellOrigin 缺省（null）：不发 frame-ancestors（不凭空造宽带）', async () => {
    const w = await loadWrapper({ moduleId: 'hello', shellOrigin: null });
    const res = await w.fetch('/m/hello/');
    expect(res.headers.has('content-security-policy')).toBe(false);
  });
});

describe('wrapper 壳 origin meta 注入（#277）：unself-shell-origin', () => {
  const MODULE_ORIGIN = 'https://unself-module-hello.test-subdomain.workers.dev';
  const CORE_ORIGIN = 'https://unself-core-api.test-subdomain.workers.dev';
  const HTML_HEAD = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>mod</title></head><body>module page</body></html>';

  it('workers.dev 根挂载 + shellOrigin：/ 命中 ASSETS /index.html（text/html）→ <head> 后注入 meta，status/content-type 保留', async () => {
    const w = await loadWrapper({
      moduleId: 'hello',
      mount: '',
      origin: MODULE_ORIGIN,
      shellOrigin: CORE_ORIGIN,
      assets: { '/index.html': HTML_HEAD },
      assetInits: { '/index.html': { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } } },
    });
    const res = await w.fetch('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await res.text();
    // 注入位置：紧跟 <head…> 开标签之后；meta 名/值 = 壳 origin
    expect(body).toBe(HTML_HEAD.replace('<head>', `<head><meta name="unself-shell-origin" content="${CORE_ORIGIN}">`));
    // frame-ancestors 语义零变更（#273 用例同款断言，同响应上共存）
    expect(res.headers.get('content-security-policy')).toBe(`frame-ancestors ${CORE_ORIGIN}`);
    expect(w.assetCalls).toEqual([{ url: '/index.html', method: 'GET' }]);
    expect(w.workerCalls).toHaveLength(0);
  });

  it('根挂载：/index.html 预取 404 → 落 worker 渲染的 HTML（text/html）→ meta 同样注入', async () => {
    const w = await loadWrapper({
      moduleId: 'hello',
      mount: '',
      origin: MODULE_ORIGIN,
      shellOrigin: CORE_ORIGIN,
      assets: {},
      workerResponse: 'html',
    });
    const res = await w.fetch('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await res.text();
    expect(body).toContain(`<meta name="unself-shell-origin" content="${CORE_ORIGIN}">`);
    expect(body).toContain('worker page');
    expect(w.workerCalls).toEqual([{ pathname: '/', method: 'GET', body: null }]);
  });

  it('非 HTML（/app.js，application/javascript）：body 逐字节不变、无 meta（frame-ancestors 语义不受影响）', async () => {
    const w = await loadWrapper({
      moduleId: 'hello',
      mount: '',
      origin: MODULE_ORIGIN,
      shellOrigin: CORE_ORIGIN,
      assets: { '/app.js': 'console.log("exactly-bytes")' },
      assetInits: { '/app.js': { status: 200, headers: { 'content-type': 'application/javascript; charset=utf-8' } } },
    });
    const res = await w.fetch('/app.js');
    expect(res.status).toBe(200);
    const jsBody = await res.text();
    // 逐字节不变 + 无 meta（一次读取，Response body 不可重复消费）
    expect(jsBody).toBe('console.log("exactly-bytes")');
    expect(jsBody).not.toContain('unself-shell-origin');
    expect(res.headers.get('content-security-policy')).toBe(`frame-ancestors ${CORE_ORIGIN}`);
  });

  it('shellOrigin 缺省（null）：HTML 原样返回，无 meta、无 frame-ancestors', async () => {
    const w = await loadWrapper({
      moduleId: 'hello',
      mount: '',
      origin: MODULE_ORIGIN,
      shellOrigin: null,
      assets: { '/index.html': HTML_HEAD },
      assetInits: { '/index.html': { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } } },
    });
    const res = await w.fetch('/');
    const body = await res.text();
    expect(body).toBe(HTML_HEAD);
    expect(body).not.toContain('unself-shell-origin');
    expect(res.headers.has('content-security-policy')).toBe(false);
  });

  it('幂等：HTML 已含 unself-shell-origin meta → 不重复插（仍一处），frame-ancestors 照补/已有 CSP 不覆盖', async () => {
    const marked = '<!doctype html><html><head><meta name="unself-shell-origin" content="https://else.example"></head></html>';
    const w = await loadWrapper({
      moduleId: 'hello',
      mount: '',
      origin: MODULE_ORIGIN,
      shellOrigin: CORE_ORIGIN,
      assets: { '/index.html': marked },
      assetInits: {
        '/index.html': {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': 'frame-ancestors https://else.example',
          },
        },
      },
    });
    const res = await w.fetch('/');
    const body = await res.text();
    // meta 不重复：仍只有模块自带的那一处（值不被改写）
    expect(body).toBe(marked);
    expect(body.split('unself-shell-origin')).toHaveLength(2);
    // frame-ancestors 照补语义：已有 CSP → 不覆盖，保留模块自身值
    expect(res.headers.get('content-security-policy')).toBe('frame-ancestors https://else.example');
  });

  it('幂等 + 无 CSP：meta 不重复插，frame-ancestors 仍按壳 origin 补齐（幂等不豁免 CSP）', async () => {
    const marked = '<!doctype html><html><head><meta name="unself-shell-origin" content="https://else.example"></head></html>';
    const w = await loadWrapper({
      moduleId: 'hello',
      mount: '',
      origin: MODULE_ORIGIN,
      shellOrigin: CORE_ORIGIN,
      assets: { '/index.html': marked },
      assetInits: { '/index.html': { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } } },
    });
    const res = await w.fetch('/');
    expect(await res.text()).toBe(marked);
    expect(res.headers.get('content-security-policy')).toBe(`frame-ancestors ${CORE_ORIGIN}`);
  });

  it('幂等 + 失真标头：content-encoding/content-length 照删（body 经 text() 重建，幂等短路也不例外）', async () => {
    const marked = '<!doctype html><html><head><meta name="unself-shell-origin" content="https://else.example"></head></html>';
    const w = await loadWrapper({
      moduleId: 'hello',
      mount: '',
      origin: MODULE_ORIGIN,
      shellOrigin: CORE_ORIGIN,
      assets: { '/index.html': marked },
      assetInits: {
        '/index.html': {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-encoding': 'gzip',
            'content-length': '123',
          },
        },
      },
    });
    const res = await w.fetch('/');
    expect(res.headers.has('content-encoding')).toBe(false);
    expect(res.headers.has('content-length')).toBe(false);
    expect(await res.text()).toBe(marked);
  });

  it('无 <head> 的 HTML：meta 前置到最前（body 其余部分逐字节保留）', async () => {
    const fragment = '<div>no head at all</div>';
    const w = await loadWrapper({
      moduleId: 'hello',
      mount: '',
      origin: MODULE_ORIGIN,
      shellOrigin: CORE_ORIGIN,
      assets: { '/index.html': fragment },
      assetInits: { '/index.html': { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } } },
    });
    const res = await w.fetch('/');
    expect(await res.text()).toBe(`<meta name="unself-shell-origin" content="${CORE_ORIGIN}">${fragment}`);
  });

  it('body 改写后 content-encoding/content-length 不残留（长度/编码标头已失真，必须删除）', async () => {
    const w = await loadWrapper({
      moduleId: 'hello',
      mount: '',
      origin: MODULE_ORIGIN,
      shellOrigin: CORE_ORIGIN,
      assets: { '/index.html': HTML_HEAD },
      assetInits: {
        '/index.html': {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-encoding': 'gzip',
            'content-length': '123',
          },
        },
      },
    });
    const res = await w.fetch('/');
    expect(res.headers.has('content-encoding')).toBe(false);
    expect(res.headers.has('content-length')).toBe(false);
    expect(await res.text()).toContain(`content="${CORE_ORIGIN}"`);
  });

  it('204（无 body 状态）：不注入 meta，frame-ancestors 照常保留在头', async () => {
    const w = await loadWrapper({
      moduleId: 'hello',
      mount: '',
      origin: MODULE_ORIGIN,
      shellOrigin: CORE_ORIGIN,
      assets: { '/index.html': '' },
      assetInits: {
        '/index.html': { status: 204, headers: { 'content-type': 'text/html; charset=utf-8' } },
      },
    });
    const res = await w.fetch('/');
    expect(res.status).toBe(204);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('content-security-policy')).toBe(`frame-ancestors ${CORE_ORIGIN}`);
  });
});
