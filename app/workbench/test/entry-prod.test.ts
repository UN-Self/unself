// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 生产组合根的行为测试（#209 → #303 搬进包内）：`src/entry.prod.ts` 是**真源文件**，
 * 直接 import 执行，断言打在「回退出来的 HTML 有没有安全头」——而不是断言源码里有没有那行调用。
 *
 * 为什么必须测这一层：静态资产路径的头上在 `web/public/_headers`，
 * 而 `/setup*` 走 Worker（run_worker_first）→ 头只在组合根里补。两者漏一个就是漏一面。
 *
 * #303 之前它住在 installer，靠「把生成入口写进临时目录（深度对齐 .deploy/cloudflare）再 import」来测——
 * 那是「打包方在 app 外面」逼出来的迂回；入口成为包内源文件后，这里就是普通 import。
 */
import { describe, expect, it } from 'vitest';

import entry, { type ProdEnv } from '../src/entry.prod';

/** 测试用的窄接口：env 由用例给，ctx 空壳。 */
type LoadedEntry = { fetch: (request: Request) => Promise<Response> };

/** 组装一个可调用的 `fetch`（假 ASSETS：body/content-type 由用例指定）。 */
function loadGeneratedEntry(options?: {
  assetsHtml?: string | null;
  /** 资产响应的 body（缺省 = assetsHtml；给非 HTML 资产用）。 */
  assetsBody?: string;
  /** 资产响应的 content-type（#279 后应为上传时定对的真类型）。 */
  assetsContentType?: string;
  /** 注册表行（#273：frame-src 白名单真值源）；缺省 = 无 CORE_DB 绑定。 */
  registryManifests?: Array<{ entry: string }>;
}): LoadedEntry {
  const html = options?.assetsHtml === null ? undefined : (options?.assetsHtml ?? '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head><body>shell</body></html>');
  const body = options?.assetsBody ?? html;
  const contentType = options?.assetsContentType ?? 'text/html; charset=utf-8';
  const env: Record<string, unknown> = {
    ASSETS: {
      fetch: async (): Promise<Response> => {
        if (body === undefined) return new Response('not here', { status: 404, headers: { 'content-type': 'text/plain' } });
        return new Response(body, { status: 200, headers: { 'content-type': contentType } });
      },
    },
  };
  if (options?.registryManifests) {
    // 最小 D1 形状：registryFrameOrigins 只调 prepare(...).all() 读 manifest_json
    env.CORE_DB = {
      prepare: () => ({
        all: async () => ({
          results: options.registryManifests!.map((m) => ({ manifest_json: JSON.stringify(m) })),
        }),
      }),
    };
  }

  return {
    fetch: (request: Request) => entry.fetch(request, env as unknown as ProdEnv, {} as ExecutionContext),
  };
}

describe('生产组合根（@unself/workbench src/entry.prod.ts）：SPA 回退的 HTML 必须带安全头', () => {
  it('/setup（走 Worker 的页面导航）回退出的 HTML 带 CSP + X-Frame-Options', async () => {
    const app = loadGeneratedEntry();
    const res = await app.fetch(new Request('https://team.example.com/setup?token=x'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('SPA 深链（如 /admin/invites）同样带头', async () => {
    const app = loadGeneratedEntry();
    const res = await app.fetch(new Request('https://team.example.com/admin/invites'));
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('API 的 404 仍是 JSON 且不加 CSP（不回退、不上 HTML 头）', async () => {
    const app = loadGeneratedEntry();
    const res = await app.fetch(new Request('https://team.example.com/api/nope'));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.has('content-security-policy')).toBe(false);
  });

  it('回退拿到的不是 HTML（资产 404 文本）时也不硬加头', async () => {
    const app = loadGeneratedEntry({ assetsHtml: null });
    const res = await app.fetch(new Request('https://team.example.com/some-page'));
    expect(res.headers.has('content-security-policy')).toBe(false);
  });

  it('workers.dev（#273）：壳 HTML 的 frame-src 含注册表里模块自有子域 origin（跨子域 iframe 放行口）', async () => {
    const app = loadGeneratedEntry({
      registryManifests: [
        { entry: 'https://unself-module-hello.test-subdomain.workers.dev/' },
        { entry: 'https://unself-workbench.test-subdomain.workers.dev/' },
      ],
    });
    const res = await app.fetch(
      new Request('https://unself-workbench.test-subdomain.workers.dev/', { headers: { accept: 'text/html' } }),
    );
    const csp = res.headers.get('content-security-policy') ?? '';
    // 模块 origin 入选；壳自身 origin 不当白名单（同源已由 'self' 覆盖）
    expect(csp).toContain('https://unself-module-hello.test-subdomain.workers.dev');
    expect(csp).not.toContain('https://unself-workbench.test-subdomain.workers.dev');
    expect(csp).toContain("frame-src 'self'");
    // 同时改写下发 HTML 的 CSP meta（#247b：meta∩头部交集）
    const body = await res.text();
    expect(body).toContain('https://unself-module-hello.test-subdomain.workers.dev');
  });

  it('workers.dev（#279）：资产类型退化成 octet-stream 时**不再**被伪造为 text/html——故障显式透出，不许伪装', async () => {
    // #273 时代的 asHtmlDocument 会把导航请求命中的非 HTML 资产强改成 text/html，
    // 从而把「上传 part 类型错」的回归藏起来（HTML 照常、只有 module 脚本白屏）。
    // #279 修在上传侧（rest/mime.ts）后该兜底被删除：worker 只给真 HTML 补安全头，其余原样透出。
    const app = loadGeneratedEntry({
      assetsContentType: 'application/octet-stream',
      registryManifests: [{ entry: 'https://unself-module-hello.test-subdomain.workers.dev/' }],
    });
    const res = await app.fetch(
      new Request('https://unself-workbench.test-subdomain.workers.dev/', {
        headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      }),
    );
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.has('content-security-policy')).toBe(false);
  });

  it('workers.dev（#279）：导航请求命中真 JS 资产时类型与 body 原样透出（不伪造 text/html、不加 CSP）', async () => {
    const app = loadGeneratedEntry({
      assetsContentType: 'text/javascript; charset=utf-8',
      assetsBody: 'export const x = 1;',
    });
    const res = await app.fetch(
      new Request('https://unself-workbench.test-subdomain.workers.dev/assets/index-abc.js', {
        headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      }),
    );
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.has('content-security-policy')).toBe(false);
    expect(await res.text()).toBe('export const x = 1;');
  });
});
