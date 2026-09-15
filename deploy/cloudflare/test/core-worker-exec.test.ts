// SPDX-License-Identifier: AGPL-3.0-only
/**
 * core 入口产物的行为测试（#209 / M1 复核 S8）：把 `coreWorkerEntrySource` 的产物写进
 * 临时目录（与 .deploy/cloudflare 同深度，相对 import 才解析得到）后**真实 import 执行**，
 * 断言打在「回退出来的 HTML 有没有安全头」——而不是断言源码里有没有那行调用。
 *
 * 为什么必须测生成物：静态资产路径的头上在 `apps/shell/public/_headers`，
 * 而 `/setup*` 走 Worker（run_worker_first）→ 头只在生成入口里补。两者漏一个就是漏一面。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { coreWorkerEntrySource } from '../src/steps';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const temps: string[] = [];

afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

/** 生成产物的 default 导出（与 Workers 的 fetch(request, env, ctx) 约定一致）。 */
type GeneratedModule = {
  default: { fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> };
};
/** 测试用的窄接口：env/ctx 已在装配时注入。 */
type LoadedEntry = { fetch: (request: Request) => Promise<Response> };

/** 生成入口产物并 import 成一个可调用的 `fetch`（假 ASSETS 只认 `/`，回 HTML）。 */
async function loadGeneratedEntry(options?: { assetsHtml?: string | null }): Promise<LoadedEntry> {
  const dir = await mkdtemp(join(REPO_ROOT, '.tmp-209-'));
  temps.push(dir);
  const file = join(dir, 'core-worker.js');
  await writeFile(file, coreWorkerEntrySource(dir, REPO_ROOT));

  const html = options?.assetsHtml === null ? undefined : (options?.assetsHtml ?? '<!doctype html><html><body>shell</body></html>');
  const env = {
    ASSETS: {
      fetch: async (): Promise<Response> => {
        if (html === undefined) return new Response('not here', { status: 404, headers: { 'content-type': 'text/plain' } });
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
    },
  };

  const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as GeneratedModule;
  return {
    fetch: (request: Request) => mod.default.fetch(request, env, {}),
  };
}

describe('生成的 core 入口（#209）：SPA 回退的 HTML 必须带安全头', () => {
  it('/setup（走 Worker 的页面导航）回退出的 HTML 带 CSP + X-Frame-Options', async () => {
    const entry = await loadGeneratedEntry();
    const res = await entry.fetch(new Request('https://team.example.com/setup?token=x'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('SPA 深链（如 /admin/invites）同样带头', async () => {
    const entry = await loadGeneratedEntry();
    const res = await entry.fetch(new Request('https://team.example.com/admin/invites'));
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('API 的 404 仍是 JSON 且不加 CSP（不回退、不上 HTML 头）', async () => {
    const entry = await loadGeneratedEntry();
    const res = await entry.fetch(new Request('https://team.example.com/api/nope'));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.has('content-security-policy')).toBe(false);
  });

  it('回退拿到的不是 HTML（资产 404 文本）时也不硬加头', async () => {
    const entry = await loadGeneratedEntry({ assetsHtml: null });
    const res = await entry.fetch(new Request('https://team.example.com/some-page'));
    expect(res.headers.has('content-security-policy')).toBe(false);
  });
});
