// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import app from '../src/index';

/**
 * #13 测试：假 JWKS（本测内生成 ES256 对，服务 JWKS 端点）+
 * 内存假 D1（module_kv 表语义，与 #9 假 D1 同构）。
 * 验收链路：SDK 存储读写 hello 计数、跨前缀拒绝由 SDK 层保证（#9 用例），
 * 这里验证 HTTP 面验签/计数/生命周期骨架。
 */

/** 内存 module_kv（与 #9 存储模型一致：module_id 列隔离）。 */
function makeDb(): D1Database & { _rows: Map<string, Map<string, string>> } {
  const rows = new Map<string, Map<string, string>>();
  const prepare = (sql: string) => {
    const chain = {
      _args: [] as unknown[],
      bind(...args: unknown[]) {
        chain._args = args;
        return chain;
      },
      async first<T>(): Promise<T | null> {
        const [moduleId, key] = chain._args as [string, string];
        if (sql.includes('SELECT value FROM')) {
          const value = rows.get(moduleId)?.get(key);
          return (value !== undefined ? { value } : null) as T | null;
        }
        return null;
      },
      async all<T>() {
        const [moduleId] = chain._args as [string];
        const keys = rows.get(moduleId) ?? new Map();
        const results = [...keys.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key]) => ({ key }));
        return { results } as { results: T[] };
      },
      async run() {
        const [moduleId, key, value] = chain._args as [string, string, string];
        if (sql.startsWith('INSERT INTO')) {
          if (!rows.has(moduleId)) rows.set(moduleId, new Map());
          rows.get(moduleId)!.set(key, value);
        } else if (sql.startsWith('DELETE FROM')) {
          rows.get(moduleId)?.delete(key);
        }
        return { success: true };
      },
    };
    return chain;
  };
  return { prepare, _rows: rows } as unknown as D1Database & { _rows: Map<string, Map<string, string>> };
}

let privateKey: CryptoKey;

/** 造 aud=hello 的合法模块 token。 */
async function makeToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ iss: 'https://core.example', sub: 'u_1', aud: 'hello', name: '黄一', email: 'huang@example.com', ...overrides })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

/** 假 Core：/.well-known/jwks.json 返回测试公钥；token 校验走真实 jose。 */
async function envFor(): Promise<{ MODULES_DB: D1Database & { _rows: Map<string, Map<string, string>> }; CORE_JWKS_URL: string }> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  const jwksBody = JSON.stringify({ keys: [{ ...publicJwk, use: 'sig', alg: 'ES256' }] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/.well-known/jwks.json')) {
      return new Response(jwksBody, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${String(input)}`);
  }) as typeof fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  return { MODULES_DB: makeDb(), CORE_JWKS_URL: 'https://core.example/.well-known/jwks.json' };
}

describe('module-hello（#13 垂直切片载体）', () => {
  it('GET /api/health 保持可用', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
  });

  it('无 Bearer 的 /api/count 回 401（人话 + requestId）', async () => {
    const env = await envFor();
    const res = await app.request('https://m.example/api/count', {}, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; requestId?: string };
    expect(body.error).not.toMatch(/jose|jwt/i);
  });

  it('aud≠hello 的 token 被拒（aud 锁定，§5.2 防跨模块重放）', async () => {
    const env = await envFor();
    const token = await makeToken({ aud: 'other-module' });
    const res = await app.request('https://m.example/api/count', { headers: { authorization: `Bearer ${token}` } }, env);
    expect(res.status).toBe(401);
  });

  it('GET /api/count 初始为 0；POST +1 后刷新持久（验收 1）', async () => {
    const env = await envFor();
    const token = await makeToken();
    const headers = { authorization: `Bearer ${token}` };

    const initial = await app.request('https://m.example/api/count', { headers }, env);
    expect(await initial.json()).toEqual({ count: 0 });

    const inc = await app.request('https://m.example/api/count', { method: 'POST', headers }, env);
    expect(await inc.json()).toEqual({ count: 1 });

    // 刷新持久（同一存储再读）
    const again = await app.request('https://m.example/api/count', { headers }, env);
    expect(await again.json()).toEqual({ count: 1 });
  });

  it('计数写入落在 hello 子域（module_id=hello，SDK 收口）', async () => {
    const env = await envFor();
    const token = await makeToken();
    await app.request('https://m.example/api/count', { method: 'POST', headers: { authorization: `Bearer ${token}` } }, env);
    // SDK 键模型：module_kv(module_id='hello', key='counter')
    expect(env.MODULES_DB._rows.get('hello')?.get('counter')).toBe('1');
  });

  it('身份行数据源：claims 姓名/邮箱进入 token（验收 2 的数据面）', async () => {
    const env = await envFor();
    const token = await makeToken();
    const { decodeJwtPayload } = await import('@unself/module-sdk');
    const claims = decodeJwtPayload(token) as { name?: string; email?: string };
    expect(claims.name).toBe('黄一');
    expect(claims.email).toBe('huang@example.com');
  });

  it('GET /life/export 返回契约形状 ExportBundle', async () => {
    const env = await envFor();
    const token = await makeToken();
    await app.request('https://m.example/api/count', { method: 'POST', headers: { authorization: `Bearer ${token}` } }, env);
    const res = await app.request('https://m.example/life/export', {}, env);
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as {
      version: number;
      moduleId: string;
      tables: Record<string, { schemaVersion: number; rows: unknown[] }>;
      files: unknown[];
    };
    expect(bundle.version).toBe(1);
    expect(bundle.moduleId).toBe('hello');
    expect(bundle.tables.hello_counter?.rows).toEqual([{ scope: 'global', n: 1 }]);
    expect(bundle.files).toEqual([]);
  });

  it('POST /life/purge 清空模块子域数据', async () => {
    const env = await envFor();
    const token = await makeToken();
    const headers = { authorization: `Bearer ${token}` };
    await app.request('https://m.example/api/count', { method: 'POST', headers }, env);
    const purge = await app.request('https://m.example/life/purge', { method: 'POST' }, env);
    expect(await purge.json()).toEqual({ ok: true });
    const after = await app.request('https://m.example/api/count', { headers }, env);
    expect(await after.json()).toEqual({ count: 0 });
  });

  it('模块页包含身份行/计数/+1 骨架（验收 2/3 的 UI 面）', async () => {
    const res = await app.request('https://m.example/');
    const html = await res.text();
    expect(html).toContain('id="who"');
    expect(html).toContain('id="email"');
    expect(html).toContain('+1');
    expect(html).toContain('createModuleSDK');
    expect(html).toContain('viewport');
  });
});
