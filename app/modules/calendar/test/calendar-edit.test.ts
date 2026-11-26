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

/** A-3 路由级集成测试：真路由 + 真 SQLite + 真 JWKS，覆盖 200/400/401/403/404/409 与并发唯一成功。 */

let db: CalendarTestDb;
let env: Record<string, unknown>;

beforeEach(() => {
  db = createCalendarDb();
  env = { DB: db.d1, CORE_JWKS_JSON: '', CORE_ISSUER: '' };
});

afterEach(() => {
  db.close();
});

async function patchEvent(
  id: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return await app.request(
    `https://calendar.example/api/events/${id}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe('PATCH /api/events/:id 正常路径', () => {
  it('改标题 → 200 且版本 +1、流水记录了 changedFields', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a', name: '黄一' });
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a', version: 3 });

    const res = await patchEvent('evt_1', { title: '项目周会（改）', version: 3 }, authHeaders(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { title: string; version: number }; version: number };
    expect(body.event.title).toBe('项目周会（改）');
    expect(body.version).toBe(4);

    const row = db.first<{ version: number; title: string }>(
      'SELECT version, title FROM calendar_events WHERE id = ?',
      'evt_1',
    );
    expect(row?.version).toBe(4);

    const changes = db.query<{ changed_fields: string; actor_name: string; to_version: number }>(
      'SELECT changed_fields, actor_name, to_version FROM calendar_event_changes',
    );
    expect(changes).toHaveLength(1);
    expect(JSON.parse(changes[0]!.changed_fields)).toEqual(['title']);
    expect(changes[0]!.actor_name).toBe('黄一');
    expect(changes[0]!.to_version).toBe(4);
  });

  it('改时间与时区 → 多字段变更按 EDITABLE_FIELDS 顺序记录', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a', version: 1 });

    const res = await patchEvent(
      'evt_1',
      { startAt: 1_700_100_000_000, endAt: 1_700_104_000_000, timezone: 'Asia/Tokyo', version: 1 },
      authHeaders(token),
    );
    expect(res.status).toBe(200);
    const changes = db.query<{ changed_fields: string }>(
      'SELECT changed_fields FROM calendar_event_changes',
    );
    expect(JSON.parse(changes[0]!.changed_fields)).toEqual(['startAt', 'endAt', 'timezone']);
  });

  it('业务字段没变化 → 200 幂等，不写库不写流水', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a', version: 3, title: '周会' });

    const res = await patchEvent('evt_1', { title: '周会', version: 3 }, authHeaders(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number };
    expect(body.version).toBe(3);
    expect(db.query('SELECT * FROM calendar_event_changes')).toHaveLength(0);
  });

  it('旧版本提交无变化的补丁 → 409（不因幂等短路放过过期视图）', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a', version: 5, title: '周会' });

    const res = await patchEvent('evt_1', { title: '周会', version: 3 }, authHeaders(token));
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      event: { title: string; version: number };
      version: number;
    };
    expect(body.error).toBe('version_conflict');
    expect(body.version).toBe(5);
    expect(body.event.title).toBe('周会');
    expect(db.query('SELECT * FROM calendar_event_changes')).toHaveLength(0);
  });
});

describe('PATCH 400：校验拒绝', () => {
  it.each([
    ['空标题', { title: '   ', version: 3 }, 'title_required', 'title'],
    ['标题超长', { title: 'x'.repeat(201), version: 3 }, 'title_too_long', 'title'],
    ['开始不早于结束', { startAt: 1_700_000_000_000, endAt: 1_700_000_000_000, version: 3 }, 'start_must_be_before_end', 'startAt'],
    ['时区不存在', { timezone: 'Mars/Olympus', version: 3 }, 'timezone_invalid', 'timezone'],
    ['状态非法', { status: 'done', version: 3 }, 'status_invalid', 'status'],
    ['只读字段', { id: 'evt_1', version: 3 }, 'readonly_field', 'id'],
    ['未知字段', { titel: '拼错', version: 3 }, 'unknown_field', 'titel'],
    ['空补丁', { version: 3 }, 'empty_patch', undefined],
    ['版本缺失', { title: '改' }, 'version_required', 'version'],
    ['版本非整数', { title: '改', version: '3' }, 'version_invalid', 'version'],
    ['allDay 非布尔', { allDay: 1, version: 3 }, 'allDay_must_be_boolean', 'allDay'],
    ['startAt 非整数', { startAt: 1.5, version: 3 }, 'startAt_must_be_integer_ms', 'startAt'],
  ])('%s → 400', async (_name, body, error, field) => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a', version: 3 });

    const res = await patchEvent('evt_1', body, authHeaders(token));
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string; field?: string };
    expect(payload.error).toBe(error);
    expect(payload.field).toBe(field);
  });

  it('请求体不是 JSON → 400', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a' });

    const res = await app.request(
      'https://calendar.example/api/events/evt_1',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(token) },
        body: '{坏 json',
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH 401 / 503：认证面', () => {
  it('无 token / 乱串 / 错 aud / 过期 / 错签 → 401', async () => {
    const { makeToken, signWithForeignKey } = await mintSetup(env);
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a' });

    const cases: Array<[string, Promise<string> | undefined]> = [
      ['no-token', undefined],
      ['garbage', Promise.resolve('not-a-jwt')],
      ['wrong-aud', makeToken({ aud: 'other-module' })],
      ['expired', makeToken({}, -10)],
      ['wrong-signature', signWithForeignKey()],
    ];
    for (const [name, tokenPromise] of cases) {
      const headers = tokenPromise === undefined ? {} : authHeaders(await tokenPromise);
      const res = await patchEvent('evt_1', { title: '改', version: 3 }, {
        ...headers,
      });
      expect(res.status, name).toBe(401);
    }
  });

  it('缺 CORE_JWKS_JSON → 503（验证面不可用 ≠ 未认证）', async () => {
    const { makeToken } = await mintSetup(env);
    env.CORE_JWKS_JSON = '';
    const token = await makeToken({ sub: 'u_a' });
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a' });

    const res = await patchEvent('evt_1', { title: '改', version: 3 }, authHeaders(token));
    expect(res.status).toBe(503);
  });
});

describe('PATCH 403 / 404', () => {
  it('非组织者 → 403', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_b' });
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a' });

    const res = await patchEvent('evt_1', { title: '改', version: 3 }, authHeaders(token));
    expect(res.status).toBe(403);
  });

  it('记录不存在 → 404', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });

    const res = await patchEvent('evt_missing', { title: '改', version: 3 }, authHeaders(token));
    expect(res.status).toBe(404);
  });

  it('已软删记录 → 一律 404（连原文都改不了）', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a', deletedAt: 1_700_000_000_500 });

    const res = await patchEvent('evt_1', { title: '改', version: 3 }, authHeaders(token));
    expect(res.status).toBe(404);
  });
});

describe('PATCH 409：版本冲突', () => {
  it('旧版本号 → 409 且带回当前 event 与 version', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a', version: 3 });

    // 别人先改成 v4
    db.run('UPDATE calendar_events SET version = 4 WHERE id = ?', 'evt_1');

    const res = await patchEvent('evt_1', { title: '我的改法', version: 3 }, authHeaders(token));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; event: { version: number }; version: number };
    expect(body.error).toBe('version_conflict');
    expect(body.version).toBe(4);
    expect(body.event.version).toBe(4);

    // 冲突不落库、不写流水
    expect(db.query('SELECT * FROM calendar_event_changes')).toHaveLength(0);
  });

  it('两人同时改同一条：恰好一个 200、一个 409，版本只 +1', async () => {
    const { makeToken } = await mintSetup(env);
    const a = await makeToken({ sub: 'u_a', name: '黄一' });
    const b = await makeToken({ sub: 'u_a', name: '黄一' });
    seedEvent(db, { id: 'evt_1', organizerId: 'u_a', version: 3 });

    const [resA, resB] = await Promise.all([
      patchEvent('evt_1', { title: 'A 的标题', version: 3 }, authHeaders(a)),
      patchEvent('evt_1', { title: 'B 的标题', version: 3 }, authHeaders(b)),
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const row = db.first<{ version: number }>(
      'SELECT version FROM calendar_events WHERE id = ?',
      'evt_1',
    );
    expect(row?.version).toBe(4);
    expect(db.query('SELECT * FROM calendar_event_changes')).toHaveLength(1);
  });
});

describe('认证：CORE_ISSUER 对 iss 的实际校验', () => {
  it('配了 CORE_ISSUER 且 iss 相同 → 200', async () => {
    const { makeToken } = await mintSetup(env);
    env.CORE_ISSUER = 'unself-core';
    const token = await makeToken({ sub: 'u_a', name: '黄一' });
    seedEvent(db, { id: 'evt_iss_ok', organizerId: 'u_a', version: 1 });

    const res = await patchEvent('evt_iss_ok', { title: '新标题', version: 1 }, authHeaders(token));
    expect(res.status).toBe(200);
  });

  it('配了 CORE_ISSUER 但 iss 不同 → 401', async () => {
    const { makeToken } = await mintSetup(env);
    env.CORE_ISSUER = 'other-core';
    const token = await makeToken({ sub: 'u_a', name: '黄一' });
    seedEvent(db, { id: 'evt_iss_bad', organizerId: 'u_a', version: 1 });

    const res = await patchEvent('evt_iss_bad', { title: '新标题', version: 1 }, authHeaders(token));
    expect(res.status).toBe(401);
  });
});

describe('认证：按装配器注入的实例 id 校验 aud', () => {
  it('MODULE_ID=team-calendar 且 token aud 与之一致 → 200', async () => {
    const { makeToken } = await mintSetup(env);
    env.MODULE_ID = 'team-calendar';
    const token = await makeToken({ sub: 'u_a', name: '黄一', aud: 'team-calendar' });
    seedEvent(db, { id: 'evt_aud_ok', organizerId: 'u_a', version: 1 });

    const res = await patchEvent('evt_aud_ok', { title: '新标题', version: 1 }, authHeaders(token));
    expect(res.status).toBe(200);
  });

  it('MODULE_ID=team-calendar 但 token 的 aud 仍是 calendar → 401', async () => {
    const { makeToken } = await mintSetup(env);
    env.MODULE_ID = 'team-calendar';
    const token = await makeToken({ sub: 'u_a', name: '黄一' });
    seedEvent(db, { id: 'evt_aud_bad', organizerId: 'u_a', version: 1 });

    const res = await patchEvent('evt_aud_bad', { title: '新标题', version: 1 }, authHeaders(token));
    expect(res.status).toBe(401);
  });

  it('没注 MODULE_ID 时回落 manifest.id，aud=calendar → 200', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a', name: '黄一' });
    seedEvent(db, { id: 'evt_aud_default', organizerId: 'u_a', version: 1 });

    const res = await patchEvent('evt_aud_default', { title: '新标题', version: 1 }, authHeaders(token));
    expect(res.status).toBe(200);
  });
});

describe('PATCH 409：带回最近改动人', () => {
  it('别人改过且版本过期 → 409 带 actorName', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a', name: '黄一' });
    seedEvent(db, { id: 'evt_conf', organizerId: 'u_a', version: 2 });
    seedChange(db, { id: 'ch_1', eventId: 'evt_conf', actorName: '黄二', toVersion: 2, createdAt: 1_700_000_000_500 });

    const res = await patchEvent('evt_conf', { title: '新标题', version: 1 }, authHeaders(token));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { actorName: string | null };
    expect(body.actorName).toBe('黄二');
  });
});

describe('软删口径', () => {
  it('已软删日程 PATCH → 404', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedEvent(db, { id: 'evt_del', organizerId: 'u_a', version: 1, deletedAt: 1_700_000_000_900 });

    const res = await patchEvent('evt_del', { title: '新标题', version: 1 }, authHeaders(token));
    expect(res.status).toBe(404);
  });

  it('已软删日程 GET → 404', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a' });
    seedEvent(db, { id: 'evt_del2', organizerId: 'u_a', version: 1, deletedAt: 1_700_000_000_900 });

    const res = await app.request('https://calendar.example/api/events/evt_del2', { headers: authHeaders(token) }, env);
    expect(res.status).toBe(404);
  });
});

describe('变更流水 id', () => {
  it('21 位 URL-safe 字符集', async () => {
    const { makeToken } = await mintSetup(env);
    const token = await makeToken({ sub: 'u_a', name: '黄一' });
    seedEvent(db, { id: 'evt_rid', organizerId: 'u_a', version: 1 });

    await patchEvent('evt_rid', { title: '新标题', version: 1 }, authHeaders(token));
    const id = db.first<{ id: string }>('SELECT id FROM calendar_event_changes')?.id ?? '';
    expect(id).toMatch(/^[0-9A-Za-z_-]{21}$/);
  });
});