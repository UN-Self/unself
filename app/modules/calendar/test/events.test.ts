
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from 'jose';

import app from '../src/index';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.UNSELF_CORE_URL;
});

// 模拟 Core API Storage
function makeCoreApiStub() {
  const kv = new Map<string, string>();

  const fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string'
        ? JSON.parse(init.body)
        : undefined;

    if (url.pathname === '/api/module-api/storage' || url.pathname === '/api/module-api/storage/') {
      const prefix = url.searchParams.get('prefix') ?? '';
      return Response.json({
        keys: [...kv.keys()].filter((item) => item.startsWith(prefix)).sort(),
      });
    }

    const match = /^\/api\/module-api\/storage\/(.+)$/.exec(url.pathname);

    if (!match) {
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    const key = decodeURIComponent(match[1] ?? '');

    if (method === 'GET') {
      if (!kv.has(key)) {
        return Response.json({ error: 'key not found' }, { status: 404 });
      }
      return Response.json({ key, value: kv.get(key) });
    }

    if (method === 'PUT') {
      kv.set(key, String((body as { value?: unknown })?.value ?? ''));
      return Response.json({ ok: true });
    }

    if (method === 'DELETE') {
      kv.delete(key);
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'method not allowed' }, { status: 405 });
  };

  return { fetch, kv };
}

let privateKey: CryptoKey;
let kid: string;

async function makeToken(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({
    iss: 'https://core.example',
    sub: 'user-001',
    aud: 'calendar',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function envFor() {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;

  const publicJwk = await exportJWK(pair.publicKey);
  kid = await calculateJwkThumbprint(publicJwk);

  const stub = makeCoreApiStub();

  return {
    CORE_API: stub as unknown as Fetcher,
    CORE_JWKS_JSON: JSON.stringify({
      keys: [{ ...publicJwk, kid, use: 'sig', alg: 'ES256' }],
    }),
    stub,
  };
}

describe('module-calendar events API', () => {
  it('新增日程成功并自动生成日程信息', async () => {
    const env = await envFor();
    const token = await makeToken();

    const res = await app.request(
      'https://m.example/api/events',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: '项目会议',
          description: '讨论项目进度',
          location: '会议室',
          start_time: '2026-11-16T09:00:00+08:00',
          end_time: '2026-11-16T10:00:00+08:00',
        }),
      },
      env,
    );

    expect(res.status).toBe(201);

    const body = await res.json() as {
      event: {
        id: string;
        title: string;
        creator_id: string;
        created_at: string;
        start_time: string;
        end_time: string;
      };
    };

    expect(body.event.id).toBeTruthy();
    expect(body.event.title).toBe('项目会议');
    expect(body.event.creator_id).toBe('user-001');
    expect(Number.isNaN(Date.parse(body.event.created_at))).toBe(false);
    expect(body.event.start_time).toBe('2026-11-16T01:00:00.000Z');
    expect(body.event.end_time).toBe('2026-11-16T02:00:00.000Z');

    expect(env.stub.kv.has(`event_${body.event.id}`)).toBe(true);
  });

  it('缺少 Token 时返回 401', async () => {
    const env = await envFor();

    const res = await app.request(
      'https://m.example/api/events',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: '项目会议',
          start_time: '2026-11-16T09:00:00+08:00',
          end_time: '2026-11-16T10:00:00+08:00',
        }),
      },
      env,
    );

    expect(res.status).toBe(401);
  });

  it('错误 audience 的 Token 返回 401', async () => {
    const env = await envFor();
    const token = await makeToken({ aud: 'other-module' });

    const res = await app.request(
      'https://m.example/api/events',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(401);
  });

  it('标题为空时返回 400', async () => {
    const env = await envFor();
    const token = await makeToken();

    const res = await app.request(
      'https://m.example/api/events',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: '   ',
          start_time: '2026-11-16T09:00:00+08:00',
          end_time: '2026-11-16T10:00:00+08:00',
        }),
      },
      env,
    );

    expect(res.status).toBe(400);
  });

  it('开始时间晚于结束时间时返回 400', async () => {
    const env = await envFor();
    const token = await makeToken();

    const res = await app.request(
      'https://m.example/api/events',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: '错误日程',
          start_time: '2026-11-16T11:00:00+08:00',
          end_time: '2026-11-16T10:00:00+08:00',
        }),
      },
      env,
    );

    expect(res.status).toBe(400);
  });

  it('查询日程成功并按开始时间排序', async () => {
    const env = await envFor();
    const token = await makeToken();
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };

    for (const [title, start, end] of [
      ['第二个日程', '2026-11-16T11:00:00+08:00', '2026-11-16T12:00:00+08:00'],
      ['第一个日程', '2026-11-16T09:00:00+08:00', '2026-11-16T10:00:00+08:00'],
    ]) {
      await app.request(
        'https://m.example/api/events',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            title,
            start_time: start,
            end_time: end,
          }),
        },
        env,
      );
    }

    const res = await app.request(
      'https://m.example/api/events',
      { headers },
      env,
    );

    expect(res.status).toBe(200);

    const body = await res.json() as {
      events: Array<{ title: string }>;
    };

    expect(body.events.map((event) => event.title)).toEqual([
      '第一个日程',
      '第二个日程',
    ]);
  });

  it('Node/Docker 反连态经 UNSELF_CORE_URL 访问 Core API，并保留日程持久化', async () => {
    const env = await envFor();
    const token = await makeToken();
    process.env.UNSELF_CORE_URL = 'https://core.example';

    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === '/.well-known/jwks.json') {
        return Response.json(JSON.parse(env.CORE_JWKS_JSON));
      }
      return env.stub.fetch(url, init);
    });

    const created = await app.request(
      'https://calendar.internal/api/events',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: '本地容器日程',
          start_time: '2026-11-16T09:00:00+08:00',
          end_time: '2026-11-16T10:00:00+08:00',
        }),
      },
      {},
    );
    expect(created.status).toBe(201);

    const listed = await app.request(
      'https://calendar.internal/api/events',
      { headers: { authorization: `Bearer ${token}` } },
      {},
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { events: Array<{ title: string }> };
    expect(body.events.map((event) => event.title)).toEqual(['本地容器日程']);
    expect(calls).toContain('/.well-known/jwks.json');
    expect(calls).toContain('/api/module-api/storage/');
  });
});
