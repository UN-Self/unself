// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureZoneRecord, findZone } from '../src/dns';

/** 记录 fetch 请求并回放预设响应（按 URL 前缀匹配）。 */
function stubCf(routes: Array<{ match: RegExp; respond: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const hit = routes.find((r) => r.match.test(url));
    if (!hit) return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'unmatched' }] }), { status: 404 });
    return new Response(JSON.stringify(hit.respond), { status: 200 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('findZone（逐级上溯，不引入 config zone 字段）', () => {
  it('多级子域：上溯到真实 zone handywote.top', async () => {
    const calls = stubCf([
      { match: /name=unself\.demo\.handywote\.top/, respond: { success: true, result: [] } },
      { match: /name=demo\.handywote\.top/, respond: { success: true, result: [] } },
      { match: /name=handywote\.top/, respond: { success: true, result: [{ id: 'zone-1', name: 'handywote.top', status: 'active' }] } },
    ]);
    const zone = await findZone('unself.demo.handywote.top', 'tok');
    expect(zone).toEqual({ id: 'zone-1', name: 'handywote.top' });
    expect(calls).toHaveLength(3);
  });

  it('首级即命中：domain 本身就是 zone', async () => {
    stubCf([{ match: /name=handywote\.top/, respond: { success: true, result: [{ id: 'zone-1', name: 'handywote.top', status: 'active' }] } }]);
    const zone = await findZone('handywote.top', 'tok');
    expect(zone).toEqual({ id: 'zone-1', name: 'handywote.top' });
  });

  it('全链未命中 → null（不抛错，部署继续）', async () => {
    stubCf([{ match: /name=/, respond: { success: true, result: [] } }]);
    expect(await findZone('unself.demo.handywote.top', 'tok')).toBeNull();
  });
});

describe('ensureZoneRecord（幂等 DNS 自愈）', () => {
  it('无 token → 仅日志跳过', async () => {
    const logs: string[] = [];
    const calls = stubCf([]);
    await ensureZoneRecord({ domain: 'demo.handywote.top', apiToken: undefined, log: (m) => logs.push(m) });
    expect(calls).toHaveLength(0);
    expect(logs[0]).toContain('跳过');
  });

  it('zone 未找到 → 跳过并记录原因', async () => {
    stubCf([{ match: /name=/, respond: { success: true, result: [] } }]);
    const logs: string[] = [];
    await ensureZoneRecord({ domain: 'demo.handywote.top', apiToken: 'tok', log: (m) => logs.push(m) });
    expect(logs[0]).toContain('未找到');
  });

  it('记录已存在 → 跳过创建', async () => {
    const calls = stubCf([
      { match: /zones\?name=handywote\.top/, respond: { success: true, result: [{ id: 'zone-1', name: 'handywote.top' }] } },
      { match: /dns_records\?type=A&name=unself\.demo\.handywote\.top/, respond: { success: true, result: [{ content: '192.0.2.9', proxied: true }] } },
    ]);
    const logs: string[] = [];
    await ensureZoneRecord({ domain: 'unself.demo.handywote.top', apiToken: 'tok', log: (m) => logs.push(m) });
    expect(logs[0]).toContain('已存在');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('无记录 → 创建代理 A 占位记录（192.0.2.1, proxied, ttl=1）', async () => {
    const calls = stubCf([
      { match: /zones\?name=handywote\.top/, respond: { success: true, result: [{ id: 'zone-1', name: 'handywote.top' }] } },
      { match: /dns_records\?type=A/, respond: { success: true, result: [] } },
      { match: /dns_records$/, respond: { success: true, result: { id: 'rec-1' } } },
    ]);
    const logs: string[] = [];
    await ensureZoneRecord({ domain: 'unself.demo.handywote.top', apiToken: 'tok', log: (m) => logs.push(m) });
    const created = calls.find((c) => c.method === 'POST');
    expect(created?.url).toContain('/zones/zone-1/dns_records');
    expect(created?.body).toEqual({
      type: 'A',
      name: 'unself.demo.handywote.top',
      content: '192.0.2.1',
      proxied: true,
      ttl: 1,
    });
    expect(logs[0]).toContain('已创建');
  });
});
