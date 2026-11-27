// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import app from '../src/index.ts';
import {
  authHeaders,
  createCalendarDb,
  mintSetup,
  seedChange,
  seedEvent,
  type CalendarTestDb,
} from './calendar-test-factory.ts';

/** A-4 路由级集成测试：空游标、增量、同毫秒多条、排除同条、游标不倒退。 */

let db: CalendarTestDb;
let env: Record<string, unknown>;

beforeEach(() => {
  db = createCalendarDb();
  env = { DB: db.d1, CORE_JWKS_JSON: '', CORE_ISSUER: '' };
});

afterEach(() => {
  db.close();
});

interface ChangesBody {
  changes: Array<{
    eventId: string;
    actorName: string;
    toVersion: number;
    changedFields: string[];
    createdAt: number;
  }>;
  cursor: number;
}

async function listChanges(query: string, headers: Record<string, string>): Promise<Response> {
  return await app.request(
    `https://calendar.example/api/events/changes${query}`,
    { headers },
    env,
  );
}

describe('GET /api/events/changes', () => {
  it('空游标 → 返回全部流水，cursor 为最新毫秒', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedChange(db, { id: 'c1', eventId: 'evt_1', createdAt: 1_000 });
    seedChange(db, { id: 'c2', eventId: 'evt_2', createdAt: 2_000 });

    const res = await listChanges('', authHeaders(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesBody;
    expect(body.changes).toHaveLength(2);
    expect(body.cursor).toBe(2_000);
    expect(body.changes[0]!.eventId).toBe('evt_1');
  });

  it('增量：since=cursor 只返回之后的记录', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedChange(db, { id: 'c1', eventId: 'evt_1', createdAt: 1_000 });
    seedChange(db, { id: 'c2', eventId: 'evt_2', createdAt: 3_000 });

    const first = (await (await listChanges('', authHeaders(token))).json()) as ChangesBody;
    seedChange(db, { id: 'c3', eventId: 'evt_3', createdAt: 5_000 });

    const res = await listChanges(`?since=${first.cursor}`, authHeaders(token));
    const body = (await res.json()) as ChangesBody;
    // since 含当毫秒：c2 会重复一次，前端按 eventId 去重；c3 必须出现
    expect(body.changes.some((c) => c.eventId === 'evt_3')).toBe(true);
    expect(body.changes.some((c) => c.eventId === 'evt_1')).toBe(false);
    expect(body.cursor).toBe(5_000);
  });

  it('同一毫秒的多个事件全部返回（不按毫秒去重丢记录）', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedChange(db, { id: 'c1', eventId: 'evt_1', createdAt: 7_000 });
    seedChange(db, { id: 'c2', eventId: 'evt_2', createdAt: 7_000 });

    const body = (await (await listChanges('?since=7000', authHeaders(token))).json()) as ChangesBody;
    expect(body.changes.map((c) => c.eventId)).toEqual(['evt_1', 'evt_2']);
  });

  it('excludeEventId 排除自己刚改的那条', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedChange(db, { id: 'c1', eventId: 'evt_1', createdAt: 1_000 });
    seedChange(db, { id: 'c2', eventId: 'evt_2', createdAt: 2_000 });

    const body = (await (
      await listChanges('?excludeEventId=evt_1', authHeaders(token))
    ).json()) as ChangesBody;
    expect(body.changes.map((c) => c.eventId)).toEqual(['evt_2']);
  });

  it('没有新记录时 cursor 不倒退（保持调用方的 since）', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedChange(db, { id: 'c1', eventId: 'evt_1', createdAt: 1_000 });

    const body = (await (await listChanges('?since=9000', authHeaders(token))).json()) as ChangesBody;
    expect(body.changes).toHaveLength(0);
    expect(body.cursor).toBe(9000);
  });

  it('PATCH 成功后立即可见（不带 exclude 自己能看到，带则被排除）', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a', name: '黄一' });
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a', version: 1 });

    const patched = await app.request(
      'https://calendar.example/api/events/evt_1',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ title: '改一下', version: 1 }),
      },
      env,
    );
    expect(patched.status).toBe(200);

    const all = (await (await listChanges('', authHeaders(token))).json()) as ChangesBody;
    expect(all.changes).toHaveLength(1);
    expect(all.changes[0]!.changedFields).toEqual(['title']);
    expect(all.changes[0]!.actorName).toBe('黄一');

    const excluded = (await (
      await listChanges('?excludeEventId=evt_1', authHeaders(token))
    ).json()) as ChangesBody;
    expect(excluded.changes).toHaveLength(0);
  });

  it('since 非法 → 400；无 token → 401', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });

    const bad = await listChanges('?since=abc', authHeaders(token));
    expect(bad.status).toBe(400);

    const unauthorized = await listChanges('', {});
    expect(unauthorized.status).toBe(401);
  });
});
