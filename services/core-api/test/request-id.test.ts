// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';

import app from '../src/index';
import { createCoreDb, type CoreTestDb } from './test-factory';

/**
 * x-request-id 全局中间件（#60 T3）：所有响应（含 401/403/503/错误）
 * 都必须带 `x-request-id`（req- + 16 位 hex），排障对账用。
 * 走 app.request 集成：auth / registry / setup / token 四类路由各一条断言 +
 * 两次请求 id 不同 + 安全字符集。
 * CORE_DB 用共享 test-factory（真 sqlite + 真迁移），不手搓假 D1（#60 标准）。
 */

const openDbs: CoreTestDb[] = [];

/** 每个用例独立真库；路由只读/空表即可走通（OIDC 未配置、无会话、无签名密钥）。 */
function env(): Record<string, unknown> {
  const db = createCoreDb();
  openDbs.push(db);
  return { CORE_DB: db.d1, JWT_PRIVATE_KEY: undefined };
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()!.close();
});

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const HEX_ID = /^req-[0-9a-f]{16}$/;

describe('x-request-id 全局中间件', () => {
  it('auth：未配置 OIDC 的 503 也带 x-request-id', async () => {
    const res = await app.request('https://team.example.com/api/auth/login', {}, env());
    expect(res.status).toBe(503);
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).toMatch(SAFE_ID);
  });

  it('registry：无会话的 401 也带 x-request-id', async () => {
    const res = await app.request('https://team.example.com/api/admin/modules', {}, env());
    expect(res.status).toBe(401);
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).toMatch(SAFE_ID);
  });

  it('setup：GET /api/setup/status 带 x-request-id', async () => {
    const res = await app.request('https://team.example.com/api/setup/status', {}, env());
    expect(res.status).toBe(200);
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).toMatch(SAFE_ID);
  });

  it('token：无签名密钥的 503 也带 x-request-id', async () => {
    const res = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST' },
      env(),
    );
    expect(res.status).toBe(503);
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).toMatch(SAFE_ID);
  });

  it('两次请求 id 不同，且格式为 req- + 16 位 hex', async () => {
    const [a, b] = await Promise.all([
      app.request('https://team.example.com/api/setup/status', {}, env()),
      app.request('https://team.example.com/api/setup/status', {}, env()),
    ]);
    const idA = a.headers.get('x-request-id');
    const idB = b.headers.get('x-request-id');
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
    expect(idA).toMatch(HEX_ID);
    expect(idB).toMatch(HEX_ID);
  });
});
