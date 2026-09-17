// SPDX-License-Identifier: AGPL-3.0-only
/**
 * REST 客户端行为测试（注入 fetch 替身，不真打网络）：
 * 信封解析 / 错误码映射 / 429 退避 / d1 import 三段式与 etag 幂等 /
 * worker 上传表单形状（metadata.main_module + 文件名字段）/ token 解析（含 wrangler 装饰剥离）。
 * 红灯点：改坏「错误码透传」「import 的 current_bookmark 轮询」「token 剥离」必红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareApiError, RestClient } from '../src/rest/client';
import { d1Import, d1Query, ensureD1 } from '../src/rest/d1';
import { parseWranglerTokenOutput, resolveToken } from '../src/rest/token';
import { putWorker } from '../src/rest/workers';
import { ensureKvNamespace, ensureR2Bucket } from '../src/rest/storage';
import { ensureRoute, findZone, removeRoutesForPatterns } from '../src/rest/zones';

/** 按请求序列回放的 fetch 替身；记录全部请求。 */
function fakeFetch(responses: Array<{ status: number; body: unknown; expect?: (req: { url: string; method: string; body?: unknown; headers: Headers }) => void }>) {
  const calls: Array<{ url: string; method: string; body?: unknown; headers: Headers }> = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const call = { url, method: init?.method ?? 'GET', body: init?.body, headers: new Headers(init?.headers) };
    calls.push(call);
    const idx = Math.min(calls.length - 1, responses.length - 1);
    const r = responses[idx]!;
    r.expect?.(call);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, impl };
}

afterEach(() => vi.unstubAllGlobals());

describe('RestClient 信封与错误映射', () => {
  it('成功信封返回 result；错误信封抛 CloudflareApiError 且 code/status 透传（红灯点：吞码必红）', async () => {
    const ok = new RestClient({ token: 't', fetchImpl: fakeFetch([{ status: 200, body: { success: true, result: { id: 'x' }, errors: [] } }]).impl });
    await expect(ok.get('/x')).resolves.toMatchObject({ result: { id: 'x' } });

    const bad = fakeFetch([{ status: 403, body: { success: false, result: null, errors: [{ code: 9109, message: 'Unauthorized' }] } }]);
    const client = new RestClient({ token: 't', fetchImpl: bad.impl, retries: 0 });
    const err = await client.get('/x').catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareApiError);
    expect((err as CloudflareApiError).code).toBe(9109);
    expect((err as CloudflareApiError).status).toBe(403);
    expect((err as CloudflareApiError).message).toContain('9109');
  });

  it('HTTP 200 但 success=false 信封 → 同样抛错（不误吞；#244 红灯点：只判状态码必红）', async () => {
    const f = fakeFetch([{ status: 200, body: { success: false, result: null, errors: [{ code: 7502, message: 'already exists' }] } }]);
    const client = new RestClient({ token: 't', fetchImpl: f.impl, retries: 0 });
    const err = await client.get('/x').catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareApiError);
    expect((err as CloudflareApiError).code).toBe(7502);
  });

  it('携带 Bearer 头；429 按重试次数退避后成功', async () => {
    const f = fakeFetch([
      { status: 429, body: { success: false, result: null, errors: [{ code: 429, message: 'rate' }] } },
      { status: 200, body: { success: true, result: 'ok', errors: [] } },
    ]);
    const client = new RestClient({ token: 'tok', fetchImpl: f.impl, retries: 1 });
    await expect(client.get('/x')).resolves.toMatchObject({ result: 'ok' });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.headers.get('Authorization')).toBe('Bearer tok');
  });

  it('非 JSON 错误体（网关 HTML）→ 带 status 的 CloudflareApiError', async () => {
    const f = fakeFetch([{ status: 502, body: '<html>bad gateway</html>' }]);
    const client = new RestClient({ token: 't', fetchImpl: f.impl, retries: 0 });
    const err = await client.get('/x').catch((e) => e);
    expect((err as CloudflareApiError).status).toBe(502);
  });
});

describe('D1 REST', () => {
  it('d1Query：POST sql+params（?N 绑定，无字符串内联）', async () => {
    const f = fakeFetch([
      { status: 200, body: { success: true, result: [{ results: [{ id: 'a' }], success: true, meta: { changes: 1, duration: 1 } }], errors: [] } },
    ]);
    const client = new RestClient({ token: 't', fetchImpl: f.impl });
    const rows = await d1Query(client, 'ACC', 'DBID', 'SELECT * FROM t WHERE id = ?1', ['a']);
    expect(rows.results).toEqual([{ id: 'a' }]);
    expect(JSON.parse(String(f.calls[0]!.body))).toEqual({ sql: 'SELECT * FROM t WHERE id = ?1', params: ['a'] });
  });

  it('d1Import：init→PUT（Content-length）→poll(current_bookmark)→complete（红灯点：改坏 bookmark 轮询必红）', async () => {
    const f = fakeFetch([
      { status: 200, body: { success: true, result: { upload_url: 'https://r2.example/put', at_bookmark: 'bm1' }, errors: [] } },
      { status: 200, body: { status: 'ongoing', at_bookmark: 'bm2' } }, // presigned PUT 响应
      { status: 200, body: { success: true, result: { status: 'complete', num_queries: 2, final_bookmark: 'bm3' }, errors: [] } },
    ]);
    const client = new RestClient({ token: 't', fetchImpl: f.impl });
    const report = await d1Import(client, 'ACC', 'DBID', 'CREATE TABLE t (id TEXT);');
    expect(report).toEqual({ numQueries: 2, finalBookmark: 'bm3' });
    // PUT 用原始字节直传 presigned URL
    expect(f.calls[1]!.url).toBe('https://r2.example/put');
    expect(f.calls[1]!.headers.get('Content-length')).toBe('25');
    // poll 带最新 bookmark
    expect(JSON.parse(String(f.calls[2]!.body))).toEqual({ action: 'poll', current_bookmark: 'bm2' });
  });

  it('ensureD1 查漏补建：命中不创建；未命中创建（幂等）', async () => {
    const hit = fakeFetch([{ status: 200, body: { success: true, result: [{ name: 'unself-core', uuid: 'u1' }], errors: [] } }]);
    const c1 = new RestClient({ token: 't', fetchImpl: hit.impl });
    await expect(ensureD1(c1, 'ACC', 'unself-core', () => {})).resolves.toBe('u1');
    expect(hit.calls).toHaveLength(1); // 只有 list，无 create

    const miss = fakeFetch([
      { status: 200, body: { success: true, result: [], errors: [] } },
      { status: 200, body: { success: true, result: { name: 'unself-core', uuid: 'u2' }, errors: [] } },
    ]);
    const c2 = new RestClient({ token: 't', fetchImpl: miss.impl });
    await expect(ensureD1(c2, 'ACC', 'unself-core', () => {})).resolves.toBe('u2');
    expect(miss.calls[1]!.method).toBe('POST');
  });
});

describe('Workers REST（上传形状实测对齐 wrangler 4.129.0）', () => {
  it('putWorker：metadata.main_module + 模块以文件名为字段（multipart）', async () => {
    let captured: RequestInit | undefined;
    const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captured = init;
      return new Response(JSON.stringify({ success: true, result: {}, errors: [] }), { status: 200 });
    };
    const client = new RestClient({ token: 't', fetchImpl: impl });
    await putWorker(client, 'ACC', {
      name: 'unself-core-api',
      mainModule: 'worker.js',
      modules: [{ name: 'worker.js', content: 'export default {};' }],
      bindings: [{ type: 'd1', name: 'CORE_DB', id: 'u1' }],
      compatibilityDate: '2026-09-01',
      compatibilityFlags: ['nodejs_compat'],
      observability: true,
    });
    const form = captured!.body as FormData;
    const meta = JSON.parse(form.get('metadata') as string);
    expect(meta.main_module).toBe('worker.js');
    expect(meta.compatibility_date).toBe('2026-09-01');
    expect(meta.bindings).toEqual([{ type: 'd1', name: 'CORE_DB', id: 'u1' }]);
    expect((form.get('worker.js') as Blob).type).toBe('application/javascript+module');
  });
});

describe('storage / zones', () => {
  it('ensureR2Bucket / ensureKvNamespace 查漏补建', async () => {
    const f = fakeFetch([
      { status: 200, body: { success: true, result: { buckets: [{ name: 'unself-storage' }] }, errors: [] } }, // r2 list 命中
      { status: 200, body: { success: true, result: [], errors: [] } }, // kv list 空
      { status: 200, body: { success: true, result: { id: 'kv1', title: 'unself-chat-sessions' }, errors: [] } }, // kv create
    ]);
    const client = new RestClient({ token: 't', fetchImpl: f.impl });
    await expect(ensureR2Bucket(client, 'ACC', 'unself-storage', () => {})).resolves.toBe('exists');
    await expect(ensureKvNamespace(client, 'ACC', 'unself-chat-sessions', () => {})).resolves.toBe('kv1');
    expect(f.calls[2]!.method).toBe('POST');
  });

  it('findZone 逐级上溯；ensureRoute 幂等（同 pattern 同 script 跳过，不同 script 更新）', async () => {
    const f = fakeFetch([
      { status: 200, body: { success: true, result: [{ id: 'z1', name: 'handywote.top' }], errors: [] } }, // zones?name=probe
      { status: 200, body: { success: true, result: [{ id: 'r1', pattern: 'probe.handywote.top/*', script: 'w' }], errors: [] } }, // routes list
    ]);
    const client = new RestClient({ token: 't', fetchImpl: f.impl });
    const zone = await findZone(client, 'probe.handywote.top');
    expect(zone).toEqual({ id: 'z1', name: 'handywote.top' });
    await ensureRoute(client, 'z1', 'probe.handywote.top/*', 'w', () => {});
    expect(f.calls).toHaveLength(2); // 命中同 script → 不发 PUT/POST
  });

  it('removeRoutesForPatterns 只删命中 pattern（红灯点：误删他人路由必红）', async () => {
    const f = fakeFetch([
      { status: 200, body: { success: true, result: [
        { id: 'r-team', pattern: 'team.handywote.top/*', script: 'real' },
        { id: 'r-hello', pattern: 'team.handywote.top/m/hello/*', script: 'mod' },
      ], errors: [] } },
    ]);
    const client = new RestClient({ token: 't', fetchImpl: f.impl });
    await removeRoutesForPatterns(client, 'z1', ['team.handywote.top/m/ghost/*'], () => {});
    expect(f.calls).toHaveLength(1); // 无命中 → 零删除请求
  });
});

describe('token 解析（#65 借用路径）', () => {
  it('parseWranglerTokenOutput：剥离 ⛅ 装饰与说明文字取 token 本体', () => {
    const out = '⛅ wrangler 4.129.0\n-------------------\neyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcd1234567890abcd1234567890abcd1234567890 前缀为 Cloudflare OAuth 令牌（93 字符）';
    expect(parseWranglerTokenOutput(out)).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcd1234567890abcd1234567890abcd1234567890');
  });

  it('resolveToken：env 优先；无 wrangler 时人话报错（红灯点：静默回空必红）', async () => {
    const env: NodeJS.ProcessEnv = { CLOUDFLARE_API_TOKEN: 'env-token' };
    expect(await resolveToken({ env, wranglerBin: '' })).toEqual({ token: 'env-token', source: 'env' });

    await expect(resolveToken({ env: {}, wranglerBin: '' })).rejects.toThrow(/wrangler login|CLOUDFLARE_API_TOKEN/);
  });

  it('resolveToken：借 wrangler OAuth（spawn 注入；输出含装饰字符）', async () => {
    const fakeExec = async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: '⛅ your token:\nabcDEF123._-abcDEF123._-abcDEF123._-abcDEF123._-abcDEF123._- done',
      stderr: '',
    });
    const res = await resolveToken({ env: {}, wranglerBin: 'wrangler', execFile: fakeExec as never });
    expect(res.source).toBe('wrangler-oauth');
    expect(res.token).toBe('abcDEF123._-abcDEF123._-abcDEF123._-abcDEF123._-abcDEF123._-');
  });
});
