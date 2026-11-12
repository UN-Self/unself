// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

import { assertCoreOrigin, createModuleApi, fetchConfig } from '../src/module-api';

/**
 * 跨域模块「模块 → core」通道行为测试（决策 #63）：
 * 断言打在「请求打到哪、带什么头、返回怎么解」——fetch 用注入替身捕获，
 * 不测内部实现。coreOrigin 禁 '*' 是硬红线（决策 #63）。
 */

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 捕获请求的 fetch 替身：返回 calls，响应按序出队。 */
function fakeFetch(responses: Array<Response | Error> = []) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init: init ?? {} });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? okJson({ ok: true });
  });
  return { calls, impl };
}

const TOKEN = 'header.payload.sig';

describe('assertCoreOrigin（决策 #63 红线：coreOrigin 禁 "*"，必须确切 https origin）', () => {
  it('"*" 直接抛错（禁止回落通配）', () => {
    expect(() => assertCoreOrigin('*')).toThrow(/禁止/);
  });

  it('http 明文 / 路径尾巴 / 垃圾串都拒绝（必须是确切 origin）', () => {
    expect(() => assertCoreOrigin('http://team.example.com')).toThrow(/https origin/);
    expect(() => assertCoreOrigin('https://team.example.com/')).toThrow(/https origin/);
    expect(() => assertCoreOrigin('not a url')).toThrow(/可解析/);
    expect(() => assertCoreOrigin('')).toThrow(/可解析/);
  });

  it('合法 https origin 通过', () => {
    expect(() => assertCoreOrigin('https://team.example.com')).not.toThrow();
  });
});

describe('createModuleApi 请求行为', () => {
  it('请求以 coreOrigin 为基准展开，带 Bearer token 与 JSON 头', async () => {
    const { calls, impl } = fakeFetch([okJson({ keys: [] })]);
    const api = createModuleApi({
      coreOrigin: 'https://team.example.com',
      getToken: () => TOKEN,
      fetchImpl: impl,
    });
    await api.storageList();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://team.example.com/api/module-api/storage/');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('每次请求现场取 token（续期后自动用新 token）', async () => {
    const { calls, impl } = fakeFetch([okJson({ keys: [] }), okJson({ keys: [] })]);
    const api = createModuleApi({
      coreOrigin: 'https://team.example.com',
      getToken: () => (calls.length === 0 ? 'old-token' : 'new-token'),
      fetchImpl: impl,
    });
    await api.storageList();
    await api.storageList();
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer old-token' });
    expect(calls[1]!.init.headers).toMatchObject({ authorization: 'Bearer new-token' });
  });

  it('storageGet：404 → null；200 → value', async () => {
    const { impl } = fakeFetch([okJson({ key: 'counter', value: '3' }), new Response('x', { status: 404 })]);
    const api = createModuleApi({
      coreOrigin: 'https://team.example.com',
      getToken: () => TOKEN,
      fetchImpl: impl,
    });
    expect(await api.storageGet('counter')).toBe('3');
    expect(await api.storageGet('missing')).toBeNull();
  });

  it('storagePut 发 PUT + JSON body', async () => {
    const { calls, impl } = fakeFetch([okJson({ ok: true })]);
    const api = createModuleApi({
      coreOrigin: 'https://team.example.com',
      getToken: () => TOKEN,
      fetchImpl: impl,
    });
    await api.storagePut('counter', '42');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.init.body).toBe(JSON.stringify({ value: '42' }));
  });

  it('token 未就绪时请求抛人话错误（不发请求）', async () => {
    const { calls, impl } = fakeFetch();
    const api = createModuleApi({
      coreOrigin: 'https://team.example.com',
      getToken: () => undefined,
      fetchImpl: impl,
    });
    await expect(api.storageGet('k')).rejects.toThrow(/handshake not completed/);
    expect(calls).toHaveLength(0);
  });
});

describe('fetchConfig（#349 U8：模块拉自己的配置声明与已存值）', () => {
  const SNAPSHOT = {
    config: [{ key: 'REGION', label: '区域', type: 'enum', options: ['us', 'eu'], default: 'ap' }],
    values: { REGION: 'eu' },
  };

  it('token 形态：GET /api/module-api/config 带 Authorization: Bearer', async () => {
    const { calls, impl } = fakeFetch([okJson(SNAPSHOT)]);
    const snapshot = await fetchConfig('https://team.example.com', { token: TOKEN }, impl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://team.example.com/api/module-api/config');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(snapshot).toEqual(SNAPSHOT);
  });

  it('keyHash 形态：凭据走 ?keyHash= 查询参数（模块后端只有 key，明文不出 env）', async () => {
    const { calls, impl } = fakeFetch([okJson(SNAPSHOT)]);
    const keyHash = 'a'.repeat(64);
    const snapshot = await fetchConfig('http://localhost:8787', { keyHash }, impl);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('http://localhost:8787/api/module-api/config');
    expect(url.searchParams.get('keyHash')).toBe(keyHash);
    expect(calls[0]!.init.headers).toEqual({});
    expect(snapshot.values).toEqual({ REGION: 'eu' });
  });

  it('node dev 场景豁免：http://localhost 可用（与浏览器面 assertCoreOrigin 刻意不同，见函数注释）', async () => {
    const { impl } = fakeFetch([okJson({ config: [], values: {} })]);
    await expect(fetchConfig('http://localhost:8787', { token: TOKEN }, impl)).resolves.toEqual({ config: [], values: {} });
  });

  it('"*" 禁用、垃圾地址抛人话错误（不发请求）', async () => {
    const { calls, impl } = fakeFetch();
    await expect(fetchConfig('*', { token: TOKEN }, impl)).rejects.toThrow(/禁止/);
    await expect(fetchConfig('not a url', { keyHash: 'k' }, impl)).rejects.toThrow(/可解析/);
    expect(calls).toHaveLength(0);
  });

  it('非 ok（500）与 404 都 throw（404 由调用方兜 fallback）', async () => {
    const { impl } = fakeFetch([okJson({ error: 'x' }, 500), new Response('nope', { status: 404 })]);
    await expect(fetchConfig('https://team.example.com', { token: TOKEN }, impl)).rejects.toThrow(/HTTP 500/);
    await expect(fetchConfig('https://team.example.com', { token: TOKEN }, impl)).rejects.toThrow(/HTTP 404/);
  });
});
