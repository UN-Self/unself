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
    return new Response(JSON.stringify({ worker: true, pathname: url.pathname }), { status: 200 });
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
  const fakeAssets = {
    fetch: async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      recorder.assetCalls.push({ url: url.pathname, method: 'GET' });
      const body = assetsTable[url.pathname];
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200 });
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
