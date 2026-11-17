// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { createDocsApp } from '../src/app';
import { DOCS_ROUTES } from '../src/routes';

import { claims } from './claims';

const AUTHORIZED = { authorization: 'Bearer x.y.z' };
const verifier = async () => claims();

/** 把模板路径换成可请求的具体路径（`:id` → `doc-1`）。 */
function concrete(path: string): string {
  return path.replace(':id', 'doc-1');
}

/**
 * 路由表锁死（#358 §6）：方法和路径写错是最容易「测试全绿但前端 405」的一类事故，
 * 所以表格与真实装配各验一遍——表格防契约漂移，装配防漏挂。
 */
describe('路由表', () => {
  it('就是 §6 的五个端点，顺序与动作一致', () => {
    expect(DOCS_ROUTES.map((route) => `${route.method} ${route.path} ${route.action}`)).toEqual([
      'POST /api/docs write',
      'GET /api/docs read',
      'GET /api/docs/:id read',
      'PUT /api/docs/:id write',
      'DELETE /api/docs/:id delete',
    ]);
  });
});

describe('装配后行为', () => {
  it('每条路由都真的挂上了（无 token 时逐条 401，不是 404）', async () => {
    const app = createDocsApp({ verifier });
    for (const route of DOCS_ROUTES) {
      const res = await app.request(concrete(route.path), { method: route.method });
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
      expect(await res.json()).toEqual({ error: 'missing_bearer_token' });
    }
  });

  it('认证通过后业务体仍是显式 501 占位（不假装成功）', async () => {
    const app = createDocsApp({ verifier });
    for (const route of DOCS_ROUTES) {
      const res = await app.request(concrete(route.path), {
        method: route.method,
        headers: AUTHORIZED,
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(501);
      expect(await res.json()).toEqual({ error: 'not_implemented' });
    }
  });

  it('装配时没拿到公钥：有令牌 → 503，没令牌 → 401（身份先于配置）', async () => {
    const app = createDocsApp({ verifier: null });
    const withToken = await app.request('/api/docs', { headers: AUTHORIZED });
    expect(withToken.status).toBe(503);
    expect(await withToken.json()).toEqual({ error: 'jwks_unavailable' });

    const withoutToken = await app.request('/api/docs');
    expect(withoutToken.status).toBe(401);
  });

  it('未登记的路径 / 未登记的方法一律 404（不落进任何 handler）', async () => {
    const app = createDocsApp({ verifier });
    const unknownPath = await app.request('/api/docs/doc-1/comments', { headers: AUTHORIZED });
    expect(unknownPath.status).toBe(404);

    const wrongMethod = await app.request('/api/docs', { method: 'PATCH', headers: AUTHORIZED });
    expect(wrongMethod.status).toBe(404);

    const postOnId = await app.request('/api/docs/doc-1', { method: 'POST', headers: AUTHORIZED });
    expect(postOnId.status).toBe(404);
  });

  it('verify 抛错时是 401 token_invalid（端到端，不经 requireAuth 单测）', async () => {
    const app = createDocsApp({
      verifier: async () => {
        throw new Error('boom');
      },
    });
    const res = await app.request('/api/docs', { headers: AUTHORIZED });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'token_invalid' });
  });
});
