// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { createDocsApp } from '../src/app';
import { DOCS_ROUTES } from '../src/routes';

import { claims } from './claims';
import { createDocsDb } from './d1-memory';

const AUTHORIZED = { authorization: 'Bearer x.y.z' };

/** 把模板路径换成可请求的具体路径（`:id` → `doc-1`）。 */
function concrete(path: string): string {
  return path.replace(':id', 'doc-1');
}

/** 认证为 `userId` 的应用 + 内存库；用完关库。传 `db` = 与别的用户共用同一个库。 */
function asUser(
  userId: string,
  verify: 'ok' | 'null' | 'throw' = 'ok',
  db: ReturnType<typeof createDocsDb> = createDocsDb(),
) {
  const app = createDocsApp({
    db: db.d1,
    verifier:
      verify === 'null'
        ? null
        : async () => {
            if (verify === 'throw') throw new Error('boom');
            return claims({ sub: userId });
          },
  });
  return { app, db };
}

function json(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, headers: AUTHORIZED, body: JSON.stringify(body) };
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
    const { app, db } = asUser('user-1');
    try {
      for (const route of DOCS_ROUTES) {
        const res = await app.request(concrete(route.path), { method: route.method });
        expect(res.status, `${route.method} ${route.path}`).toBe(401);
        expect(await res.json()).toEqual({ error: 'missing_bearer_token' });
      }
    } finally {
      db.close();
    }
  });

  it('认证通过后走真实业务体：新建 201、详情 200、保存 200、过期 409、删除 204、之后 404', async () => {
    const { app, db } = asUser('user-1');
    try {
      const list = await app.request('/api/docs', { headers: AUTHORIZED });
      expect(await list.json()).toEqual({ items: [], hasMore: false });

      const created = await app.request('/api/docs', json('POST', { title: '第一篇', content: 'v1' }));
      expect(created.status).toBe(201);
      const document = (await created.json()) as { id: string };
      expect(document).toMatchObject({ title: '第一篇', ownerId: 'user-1', version: 1, role: 'owner' });

      const detail = await app.request(`/api/docs/${document.id}`, { headers: AUTHORIZED });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toEqual(document);

      const saved = await app.request(
        `/api/docs/${document.id}`,
        json('PUT', { title: '第一篇', content: 'v2', baseVersion: 1 }),
      );
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ content: 'v2', version: 2, role: 'owner' });

      // 窗口 B 手里还是 baseVersion=1：409，体里带服务端当前行
      const stale = await app.request(`/api/docs/${document.id}`, json('PUT', { content: 'v3', baseVersion: 1 }));
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: 'version_conflict', current: { content: 'v2', version: 2 } });

      const paged = await app.request('/api/docs', { headers: AUTHORIZED });
      expect(await paged.json()).toMatchObject({ items: [{ id: document.id, role: 'owner' }], hasMore: false });

      const removed = await app.request(`/api/docs/${document.id}`, { method: 'DELETE', headers: AUTHORIZED });
      expect(removed.status).toBe(204);

      const gone = await app.request(`/api/docs/${document.id}`, { headers: AUTHORIZED });
      expect(gone.status).toBe(404);
      expect(await gone.json()).toEqual({ error: 'not_found' });
    } finally {
      db.close();
    }
  });

  it('请求体不合法 → 400 invalid_request', async () => {
    const { app, db } = asUser('user-1');
    try {
      const badJson = await app.request('/api/docs', { ...json('POST', {}), body: '{' });
      expect(badJson.status).toBe(400);

      // 标题 >200 字符、正文 >1MB、类型不符
      const oversized = [
        { title: 1 },
        { title: 'x'.repeat(201) },
        { title: 'ok', content: 'x'.repeat(1024 * 1024 + 1) },
      ];
      for (const body of oversized) {
        expect((await app.request('/api/docs', json('POST', body))).status).toBe(400);
      }
      // baseVersion 非正整数，或 title / content 一个都没给
      for (const body of [{ baseVersion: 0 }, { baseVersion: 1.5 }, { baseVersion: 1 }]) {
        expect((await app.request('/api/docs/doc-1', json('PUT', body))).status).toBe(400);
      }
      // 缺 title、非对象体（字符串 / null）、空体都按 invalid_request 挡下
      for (const body of [{}, 'str', null, undefined]) {
        const res = await app.request('/api/docs', json('POST', body));
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(await (await app.request('/api/docs', json('POST', { title: 1 }))).json()).toEqual({
        error: 'invalid_request',
      });
    } finally {
      db.close();
    }
  });

  it('裁决：非成员与不存在同为 404，成员角色不够 403', async () => {
    // 三个用户共用同一个库：库由最外层关一次
    const db = createDocsDb();
    const owner = asUser('owner', 'ok', db);
    const { id } = (await (await owner.app.request('/api/docs', json('POST', { title: 't' }))).json()) as {
      id: string;
    };
    db.run("INSERT INTO docs_document_members (doc_id, user_id, role) VALUES (?, 'viewer', 'viewer')", id);
    try {
      const viewer = asUser('viewer', 'ok', db);
      const read = await viewer.app.request(`/api/docs/${id}`, { headers: AUTHORIZED });
      expect(await read.json()).toMatchObject({ id, role: 'viewer' });

      const write = await viewer.app.request(`/api/docs/${id}`, json('PUT', { content: 'x', baseVersion: 1 }));
      expect(write.status).toBe(403);
      expect(await write.json()).toEqual({ error: 'forbidden' });

      const remove = await viewer.app.request(`/api/docs/${id}`, { method: 'DELETE', headers: AUTHORIZED });
      expect(remove.status).toBe(403);

      const stranger = asUser('stranger', 'ok', db);
      const foreign = await stranger.app.request(`/api/docs/${id}`, { headers: AUTHORIZED });
      const missing = await stranger.app.request('/api/docs/d_missing', { headers: AUTHORIZED });
      expect([foreign.status, missing.status]).toEqual([404, 404]);
      expect([await foreign.json(), await missing.json()]).toEqual([
        { error: 'not_found' },
        { error: 'not_found' },
      ]);
    } finally {
      db.close();
    }
  });

  it('装配时没拿到公钥：有令牌 → 503，没令牌 → 401（身份先于配置）', async () => {
    const { app, db } = asUser('user-1', 'null');
    try {
      const withToken = await app.request('/api/docs', { headers: AUTHORIZED });
      expect(withToken.status).toBe(503);
      expect(await withToken.json()).toEqual({ error: 'jwks_unavailable' });

      const withoutToken = await app.request('/api/docs');
      expect(withoutToken.status).toBe(401);
    } finally {
      db.close();
    }
  });

  it('未登记的路径 / 未登记的方法一律 404（不落进任何 handler）', async () => {
    const { app, db } = asUser('user-1');
    try {
      const unknownPath = await app.request('/api/docs/doc-1/comments', { headers: AUTHORIZED });
      expect(unknownPath.status).toBe(404);

      const wrongMethod = await app.request('/api/docs', { method: 'PATCH', headers: AUTHORIZED });
      expect(wrongMethod.status).toBe(404);

      const postOnId = await app.request('/api/docs/doc-1', { method: 'POST', headers: AUTHORIZED });
      expect(postOnId.status).toBe(404);
    } finally {
      db.close();
    }
  });

  it('verify 抛错时是 401 token_invalid（端到端，不经 requireAuth 单测）', async () => {
    const { app, db } = asUser('user-1', 'throw');
    try {
      const res = await app.request('/api/docs', { headers: AUTHORIZED });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'token_invalid' });
    } finally {
      db.close();
    }
  });
});
