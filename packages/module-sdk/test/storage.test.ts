// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCoreApiStorage, createD1Storage } from '../src/storage';

/**
 * #248 收敛（a)：存储客户端统一走 Core API 代理（/api/module-api/storage/* 四形状）。
 * 替身只出现在外部边界（HTTP fetch），按真 core-api 路由的响应形状回放；
 * 语义断言全部落在「客户端发了什么请求 / 如何解释响应」——与 core-api 的
 * module-api.test.ts（真路由侧）互为两张皮免疫：形状漂移任何一边都会红。
 */

/** fetch 替身：路由内存 KV + 请求记录。 */
function makeFetchStub(initial: Record<string, string> = {}) {
  const kv = new Map<string, string>(Object.entries(initial));
  const calls: Array<{ method: string; path: string; body?: unknown; auth?: string }> = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ method, path, body, auth });
    const m = path.match(/^\/api\/module-api\/storage\/(.*)$/);
    if (!m) return Response.json({ error: 'not found' }, { status: 404 });
    const key = decodeURIComponent(m[1] ?? '');
    if (key === '') {
      // GET /storage/ = 列键
      return Response.json({ keys: [...kv.keys()].sort() });
    }
    if (method === 'GET') {
      if (!kv.has(key)) return Response.json({ error: 'key not found' }, { status: 404 });
      return Response.json({ key, value: kv.get(key) });
    }
    if (method === 'PUT') {
      const v = (body as { value?: unknown })?.value;
      if (typeof v !== 'string') return Response.json({ error: 'body must be { value: string }' }, { status: 400 });
      kv.set(key, v);
      return Response.json({ ok: true });
    }
    if (method === 'DELETE') {
      kv.delete(key);
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'method not allowed' }, { status: 405 });
  });
  return { fetchImpl, calls, kv };
}

/** 代理客户端构造（token 现场取）。 */
function clientFor(stub: ReturnType<typeof makeFetchStub>, token = 'tok-1') {
  return createCoreApiStorage({
    coreApiOrigin: 'https://team.example.com',
    getToken: () => token,
    fetchImpl: stub.fetchImpl as unknown as (input: string, init?: RequestInit) => Promise<Response>,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCoreApiStorage（#248 收敛（a)：Core API 代理四形状）', () => {
  it('get：200 取值 / 404 回 null；请求带 Bearer 模块 token', async () => {
    const stub = makeFetchStub({ counter: '3' });
    const store = clientFor(stub);
    await expect(store.get('counter')).resolves.toBe('3');
    await expect(store.get('missing')).resolves.toBeNull();
    expect(stub.calls[0]).toMatchObject({ method: 'GET', path: '/api/module-api/storage/counter', auth: 'Bearer tok-1' });
    expect(stub.calls[1]!.path).toBe('/api/module-api/storage/missing');
  });

  it('put 覆盖写、delete 幂等；body 形状 { value } 与 core-api 契约一致', async () => {
    const stub = makeFetchStub();
    const store = clientFor(stub);
    await store.put('counter', '1');
    expect(stub.calls[0]).toMatchObject({ method: 'PUT', body: { value: '1' } });
    await store.put('counter', '2');
    await expect(stub.kv.get('counter')).toBe('2');
    await expect(stub.kv.get('counter')).toBe('2');
    await store.delete('counter');
    await store.delete('counter'); // 不存在也成功（代理 200）
    expect(stub.kv.has('counter')).toBe(false);
  });

  it('list：全量按键排序；prefix 在客户端过滤且通配符按字面处理', async () => {
    const stub = makeFetchStub({ 'a/1': 'x', 'a_2': 'y', 'b': 'z' });
    const store = clientFor(stub);
    await expect(store.list()).resolves.toEqual(['a/1', 'a_2', 'b']);
    await expect(store.list('a/')).resolves.toEqual(['a/1']);
    await expect(store.list('a_')).resolves.toEqual(['a_2']); // _ 不当通配
  });

  it('键守卫：空 key / 含保留分隔符 ":" 一律拒绝且零网络（跨前缀注入防线路径不回退）', async () => {
    const stub = makeFetchStub();
    const store = clientFor(stub);
    await expect(store.get('')).rejects.toThrow(/非空/);
    await expect(store.get('other:xxx')).rejects.toThrow(/跨前缀/);
    await expect(store.put('evil::', '1')).rejects.toThrow(/跨前缀/);
    expect(stub.fetchImpl).not.toHaveBeenCalled();
  });

  it('token 缺失 → 人话报错且零网络；coreOrigin="*" 创建即拒（#63）', async () => {
    const stub = makeFetchStub();
    const store = createCoreApiStorage({ coreApiOrigin: 'https://team.example.com', getToken: () => undefined, fetchImpl: stub.fetchImpl });
    await expect(store.get('k')).rejects.toThrow(/token/);
    expect(stub.fetchImpl).not.toHaveBeenCalled();
    expect(() =>
      createCoreApiStorage({ coreApiOrigin: '*', getToken: () => 't', fetchImpl: stub.fetchImpl }),
    ).toThrow(/"\*"/);
  });

  it('代理 5xx → 报错带状态码（不静默假成功）', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 503 }));
    const store = createCoreApiStorage({ coreApiOrigin: 'https://t.example', getToken: () => 't', fetchImpl: fetchImpl as never });
    await expect(store.put('k', 'v')).rejects.toThrow(/503/);
  });
});

describe('createD1Storage 兼容别名（#248：直连路径已死）', () => {
  it('旧直连形态 { db } → 人话报错拒用（红灯验证：死代码不再是可用通道）', () => {
    const fakeD1 = { prepare: () => { throw new Error('direct D1 must not be reached'); } };
    expect(() => createD1Storage({ db: fakeD1, moduleId: 'hello' } as never)).toThrow(/已收敛到 Core API 代理|#248|MODULES_DB/);
  });

  it('代理形态经别名可用（旧调用点零改动迁移）', async () => {
    const stub = makeFetchStub({ k: 'v' });
    const store = createD1Storage({
      coreApiOrigin: 'https://team.example.com',
      moduleId: 'hello',
      getToken: () => 't',
      fetchImpl: stub.fetchImpl as never,
    });
    await expect(store.get('k')).resolves.toBe('v');
  });
});
