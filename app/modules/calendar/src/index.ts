// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from 'hono';
import type { ModuleTokenClaims } from '@unself/contracts';
import { createCoreApiStorage, verifyModuleToken, type ModuleStorage } from '@unself/sdk';

import { renderCalendarPage } from './page';

export interface Bindings {
  /** core-api worker 的 Service Binding。CF 态才有；Node/Docker 态走 UNSELF_CORE_URL。 */
  CORE_API?: Fetcher;
  /** Core 公钥 JWKS 的 JSON 序列化（部署期注入，§5.2 B 方案：模块本地验签，零运行时网络）。 */
  CORE_JWKS_JSON?: string;
  /** Core issuer（可选校验；M0 以 aud 锁定为主）。 */
  CORE_ISSUER?: string;
}

/** 模块 id：aud 锁定 + SDK 存储子域 + 表前缀三处一致。 */
const MODULE_ID = 'calendar';

/** Service Binding 调用用的占位 origin（host 不参与路由；core-api 按路径匹配，决策 #63）。 */
const CORE_API_ORIGIN = 'https://core-api.internal';

/** Node/Docker 反连态的 core 地址；worker 态不设置。 */
function coreUrlFromEnv(): string {
  return (process.env.UNSELF_CORE_URL ?? '').replace(/\/+$/, '');
}

/**
 * 构造 core 级存储客户端（#248 收敛（a)）：token 取当前请求的模块 token（原样转交 core-api 验签），
 * CF 态走 Service Binding；Node/Docker 态走 UNSELF_CORE_URL，数据形状完全一致。
 */
function storeFor(c: Context<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>): ModuleStorage {
  const bearer = bearerFor(c);
  if (c.env.CORE_API) {
    return createCoreApiStorage({
      coreApiOrigin: CORE_API_ORIGIN,
      getToken: () => bearer,
      fetchImpl: (url, init) => c.env.CORE_API!.fetch(url, init),
    });
  }
  const coreUrl = coreUrlFromEnv();
  return createCoreApiStorage({
    coreApiOrigin: coreUrl,
    getToken: () => bearer,
    fetchImpl: (url, init) => {
      const target = new URL(url);
      return fetch(`${coreUrl}${target.pathname}${target.search}`, init);
    },
  });
}

function storageReady(c: Context<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>): boolean {
  return Boolean(c.env.CORE_API) || coreUrlFromEnv() !== '';
}

function bearerFor(c: Context<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>): string {
  return (c.req.header('authorization') ?? '').slice(7);
}

async function listStorageKeys(
  c: Context<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>,
): Promise<string[]> {
  return storeFor(c).list(EVENT_PREFIX);
}

/** 事件键前缀：SDK 键为模块子域裸键（core-api 侧落 module_kv(module_id='calendar', key='event_<id>')）。 */
const EVENT_PREFIX = 'event_';

interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  location?: string;
  start_time: string;
  end_time: string;
  creator_id: string;
  created_at: string;
}

async function saveEvent(
  store: ModuleStorage,
  event: CalendarEvent,
): Promise<void> {
  await store.put(
    `${EVENT_PREFIX}${event.id}`,
    JSON.stringify(event),
  );
}

async function getEvents(
  c: Context<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>,
  store: ModuleStorage,
): Promise<CalendarEvent[]> {
  const keys = (await listStorageKeys(c)).filter((key) => key.startsWith(EVENT_PREFIX));
  const events: CalendarEvent[] = [];

  for (const key of keys) {
    const raw = await store.get(key);
    if (raw) {
      events.push(JSON.parse(raw) as CalendarEvent);
    }
  }

  return events.sort(
    (a, b) => a.start_time.localeCompare(b.start_time),
  );
}

const app = new Hono<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>();

/** 模块页：月历 + 新增日程（本模块前端，见 src/page.ts）。
 *  页面 fetch/import 全用相对路径（不带前导 /）：同一路径制下模块同时挂载在
 *  /m/<id>/（部署）与开发期根路径，根相对路径只在后者成立——相对路径两处皆可（#14）。 */
app.get('/', (c) => {
  return c.html(renderCalendarPage());
});

app.get('/api/health', (c) => c.json({ ok: true, service: 'module-calendar' }));
app.post('/api/events', async (c) => {
  if (!storageReady(c)) {
    return c.json({ error: 'storage binding missing' }, 503);
  }

  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const body = await c.req.json();

    const { title, description, location, start_time, end_time } = body;

    if (
      typeof title !== 'string' || !title.trim() ||
      typeof start_time !== 'string' ||
      typeof end_time !== 'string'
    ) {
      return c.json({ error: 'invalid event data' }, 400);
    }

    if (
      !Number.isFinite(Date.parse(start_time)) ||
      !Number.isFinite(Date.parse(end_time)) ||
      Date.parse(start_time) >= Date.parse(end_time)
    ) {
      return c.json({ error: 'invalid event time' }, 400);
    }

    const claims = c.get('claims');

    const event: CalendarEvent = {
      id: crypto.randomUUID(),
      title: title.trim(),
      description: typeof description === 'string' ? description : '',
      location: typeof location === 'string' ? location : '',
      start_time: new Date(start_time).toISOString(),
      end_time: new Date(end_time).toISOString(),
      creator_id: claims.sub,
      created_at: new Date().toISOString(),
    };

    await saveEvent(storeFor(c), event);

    return c.json({ event }, 201);
  } catch {
    return c.json({ error: 'failed to create event' }, 500);
  }
});

app.get('/api/events', async (c) => {
  if (!storageReady(c)) {
    return c.json({ error: 'storage binding missing' }, 503);
  }

  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const events = await getEvents(c, storeFor(c));
    return c.json({ events });
    } catch (error) {
    console.error(
      'Calendar get events failed:',
      error instanceof Error ? error.message : String(error),
    );
    return c.json({ error: 'failed to get events' }, 500);
  }
});

// SDK 静态文件（页面 import /sdk/module-sdk.js）：开发期直映 node_modules 源；
// 部署期由 wrangler 构建打包（#14 装配脚本职责）。

/** 更新指定日历事件 */
app.put('/api/events/:id', async (c) => {
  if (!storageReady(c)) {
    return c.json({ error: 'storage binding missing' }, 503);
  }

  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const id = c.req.param('id');

    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      return c.json({ error: 'invalid event id' }, 400);
    }

    const store = storeFor(c);
    const key = `${EVENT_PREFIX}${id}`;
    const raw = await store.get(key);

    if (!raw) {
      return c.json({ error: 'event not found' }, 404);
    }

    const existing = JSON.parse(raw) as CalendarEvent;
    const body = await c.req.json();

    const { title, description, location, start_time, end_time } = body;

    if (
      typeof title !== 'string' || !title.trim() ||
      typeof start_time !== 'string' ||
      typeof end_time !== 'string'
    ) {
      return c.json({ error: 'invalid event data' }, 400);
    }

    if (
      !Number.isFinite(Date.parse(start_time)) ||
      !Number.isFinite(Date.parse(end_time)) ||
      Date.parse(start_time) >= Date.parse(end_time)
    ) {
      return c.json({ error: 'invalid event time' }, 400);
    }

    if (
      (description !== undefined && typeof description !== 'string') ||
      (location !== undefined && typeof location !== 'string')
    ) {
      return c.json({ error: 'invalid event data' }, 400);
    }

    const updatedEvent: CalendarEvent = {
      ...existing,
      title: title.trim(),
      description: description === undefined ? existing.description : description,
      location: location === undefined ? existing.location : location,
      start_time: new Date(start_time).toISOString(),
      end_time: new Date(end_time).toISOString(),
    };

    await saveEvent(store, updatedEvent);

    return c.json({ event: updatedEvent });
  } catch (error) {
    console.error(
      'Calendar update event failed:',
      error instanceof Error ? error.message : String(error),
    );
    return c.json({ error: 'failed to update event' }, 500);
  }
});

/** 删除指定日历事件 */
app.delete('/api/events/:id', async (c) => {
  if (!storageReady(c)) {
    return c.json({ error: 'storage binding missing' }, 503);
  }

  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const id = c.req.param('id');

    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      return c.json({ error: 'invalid event id' }, 400);
    }

    const store = storeFor(c);
    const key = `${EVENT_PREFIX}${id}`;
    const raw = await store.get(key);

    if (!raw) {
      return c.json({ error: 'event not found' }, 404);
    }

    await store.delete(key);

    return c.json({ success: true, id });
  } catch (error) {
    console.error(
      'Calendar delete event failed:',
      error instanceof Error ? error.message : String(error),
    );
    return c.json({ error: 'failed to delete event' }, 500);
  }
});
app.get('/sdk/*', (c) => c.json({ error: 'sdk asset served by deploy bundler (M0 dev: vite alias)' }, 501));

/** 用请求内 Bearer 做一次性验签（全模块认证唯一收口：本地 JWKS，零运行时网络）。 */
async function requireAuth(
  c: Context<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>,
): Promise<Response | null> {
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'missing bearer token', requestId: c.req.header('x-request-id') }, 401);
  }
  const coreJwksJson = c.env.CORE_JWKS_JSON ?? (await fetchCoreJwks());
  if (!coreJwksJson) {
    return c.json({ error: 'jwks not provisioned', requestId: c.req.header('x-request-id') }, 503);
  }
  try {
    const claims = await verifyModuleToken(auth.slice(7), {
      coreJwksJson,
      audience: MODULE_ID,
    });
    c.set('claims', claims);
    return null;
  } catch (error) {
    console.error(
      'Calendar token verification failed:',
      error instanceof Error ? error.message : String(error),
    );
    return c.json({ error: 'token invalid or expired', requestId: c.req.header('x-request-id') }, 401);
  }
}

/** Node/Docker 态从 core 公钥端点取 JWKS；worker 态仍由部署期注入，零运行时网络。 */
async function fetchCoreJwks(): Promise<string> {
  const coreUrl = coreUrlFromEnv();
  if (!coreUrl) return '';
  try {
    const res = await fetch(`${coreUrl}/.well-known/jwks.json`);
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

/** 生命周期骨架（§5.4 契约；M0 返回契约形状，全量实现随 M1 卸载剧本）。
 * 认证与 /api/count 同规（#45 遗留项②）：storage 缺绑定 503，验签不过 401。 */
app.get('/life/export', async (c) => {
  if (!storageReady(c)) {
    return c.json({ error: 'storage binding missing' }, 503);
  }
  const authError = await requireAuth(c);
  if (authError) return authError;
  // core 级落点（#248）：模块没有自己的表，导出 = 本模块在 Core API 代理侧的键值行
  // （表名 module_kv 是平台基建表，行已由 core-api 按 aud 收口到本模块子域）。
  const store = storeFor(c);
  const rows: Array<{ key: string; value: string }> = [];
  for (const key of await listStorageKeys(c)) {
    rows.push({ key, value: (await store.get(key)) ?? '' });
  }
  return c.json({
    version: 1,
    moduleId: MODULE_ID,
    exportedAt: new Date().toISOString(),
    tables: {
      module_kv: { schemaVersion: 1, rows },
    },
    files: [],
  });
});

app.post('/life/purge', async (c) => {
  if (!storageReady(c)) {
    return c.json({ error: 'storage binding missing' }, 503);
  }
  const authError = await requireAuth(c);
  if (authError) return authError;
  const store = storeFor(c);
  for (const key of await listStorageKeys(c)) {
    await store.delete(key);
  }
  return c.json({ ok: true });
});

export default app;
