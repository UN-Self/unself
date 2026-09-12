// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';

import app from '../src/index';
import { createCoreDb, type CoreTestDb } from './test-factory';

/**
 * 未命中路由的 404 口径（#116）：/api/* 与 /.well-known/* 未命中返回
 * JSON `{"error":"not found"}`（§6.5 API 层一律 JSON），其余路径不接管，
 * 维持 Hono 默认 text/plain（生产由 wrangler assets 的 SPA fallback 兜底）。
 * 同时确认 x-request-id 全局中间件对 404 也生效（#60 T3 语义）。
 * CORE_DB 用共享 test-factory（真 sqlite + 真迁移）。
 */

const openDbs: CoreTestDb[] = [];

function env(): Record<string, unknown> {
  const db = createCoreDb();
  openDbs.push(db);
  return { CORE_DB: db.d1, JWT_PRIVATE_KEY: undefined };
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()!.close();
});

describe('未命中路由的 404（#116）', () => {
  it('GET /api/nonexistent → 404 JSON，带 x-request-id', async () => {
    const res = await app.request('https://team.example.com/api/nonexistent', {}, env());
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not found' });
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).toMatch(/^req-[0-9a-f]{16}$/);
  });

  it('POST /api/nonexistent → 404 JSON（方法无关）', async () => {
    const res = await app.request('https://team.example.com/api/nonexistent', { method: 'POST' }, env());
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('GET /.well-known/nonexistent → 404 JSON（jwks 同前缀）', async () => {
    const res = await app.request('https://team.example.com/.well-known/nonexistent', {}, env());
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('GET /definitely-not-a-route → 非 500、非本 handler 的 JSON', async () => {
    const res = await app.request('https://team.example.com/definitely-not-a-route', {}, env());
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toContain('application/json');
    expect(await res.text()).not.toContain('not found"');
  });
});
