// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';

import { ExportBundleSchema } from '@unself/contracts';

import app from '../src/index';
import { createModuleDb, type ModuleTestDb } from '../../../packages/module-sdk/test/test-factory';

// 隔离网络破坏用例（零网络红测）：每个测试后还原全局 stub。
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * #71 测试：真实 ES256 keypair + 部署期注入的 CORE_JWKS_JSON（B 方案本地验签，零运行时网络）+
 * 真 SQLite module_kv（#60：假 D1 换真库——modules 统一迁移真建表，SDK 收口由真库裁决）。
 * 验收链路：SDK 存储读写 hello 计数、跨前缀拒绝由 SDK 层保证（#9/#60 用例），
 * 这里验证 HTTP 面验签/计数/生命周期骨架。
 */

let privateKey: CryptoKey;
let kid: string;

/** 造 aud=hello 的合法模块 token。 */
async function makeToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ iss: 'https://core.example', sub: 'u_1', aud: 'hello', name: '黄一', email: 'huang@example.com', ...overrides })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

/** 每次测试生成真实 ES256 密钥对；CORE_JWKS_JSON 注入 env（§5.2 B 方案：本地验签，不 stub、不发起任何网络）。 */
async function envFor(): Promise<{
  MODULES_DB: D1Database;
  CORE_JWKS_JSON: string;
  db: ModuleTestDb;
}> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  kid = await calculateJwkThumbprint(publicJwk);
  const coreJwksJson = JSON.stringify({ keys: [{ ...publicJwk, kid, use: 'sig', alg: 'ES256' }] });
  const db = createModuleDb();
  afterEach(() => {
    db.close();
  });
  return {
    MODULES_DB: db.d1 as unknown as D1Database,
    CORE_JWKS_JSON: coreJwksJson,
    db,
  };
}

describe('module-hello（#13 垂直切片载体）', () => {
  it('GET /api/health 保持可用', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
  });

  it('缺 CORE_JWKS_JSON（其余 env 正常）→ 503 且 error=jwks not provisioned', async () => {
    const env = await envFor();
    const token = await makeToken();
    const res = await app.request('https://m.example/api/count', {
      headers: { authorization: `Bearer ${token}`, 'x-request-id': 'req-no-jwks' },
    }, { MODULES_DB: env.MODULES_DB });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; requestId?: string };
    expect(body.error).toBe('jwks not provisioned');
    expect(body.requestId).toBe('req-no-jwks');
  });

  it('本地验签零网络：fetch 全局破坏（抛错）下合法 token 仍 200 且 fetch 零调用', async () => {
    const env = await envFor();
    const token = await makeToken();
    const fetchSpy = vi.fn(() => {
      throw new Error('network must not be used');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const res = await app.request('https://m.example/api/count', {
      headers: { authorization: `Bearer ${token}` },
    }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0 });
    // B 方案零运行时网络：验签路径不得触碰 fetch。
    expect(fetchSpy).toHaveBeenCalledTimes(0);
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

  it('计数写入落在 hello 子域（真库直查 module_kv 行）', async () => {
    const env = await envFor();
    const token = await makeToken();
    await app.request('https://m.example/api/count', { method: 'POST', headers: { authorization: `Bearer ${token}` } }, env);
    // SDK 键模型：module_kv(module_id='hello', key='counter')——直查真库行（不经适配器）
    expect(
      env.db.first<{ value: string }>(
        'SELECT value FROM module_kv WHERE module_id = ? AND key = ?',
        'hello',
        'counter',
      )?.value,
    ).toBe('1');
  });

  it('身份行数据源：claims 姓名/邮箱真值只能来自服务端验签通过的 token（签名载荷不可篡改）', async () => {
    const env = await envFor();
    const token = await makeToken(); // 真实 ES256 签名，payload 含 name=黄一 / email=huang@example.com

    // 正签 token：服务端真实验签（jose + JWKS）通过——验签接受的 claims 即签名载荷。
    const ok = await app.request('https://m.example/api/count', {
      headers: { authorization: `Bearer ${token}` },
    }, env);
    expect(ok.status).toBe(200);

    // 同一签名换 payload（姓名/邮箱被改写，其余字段不变）：签名不再匹配，服务端必须拒绝。
    // 证明身份行可展示的 claims（姓名/邮箱）不能由客户端任意注入，只能来自签发方签名过的 token。
    const [header, payloadB64, signature] = token.split('.');
    const payload = JSON.parse(
      Buffer.from(payloadB64!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const forged = `${header}.${Buffer.from(
      JSON.stringify({ ...payload, name: '黑客', email: 'evil@example.com' }),
    ).toString('base64url')}.${signature}`;
    const forgedRes = await app.request('https://m.example/api/count', {
      headers: { authorization: `Bearer ${forged}` },
    }, env);
    expect(forgedRes.status).toBe(401);
  });

  it('GET /life/export 带有效 token → 200 且形状过 ExportBundleSchema 解析（喂活 lifecycle-schema.ts）', async () => {
    const env = await envFor();
    const token = await makeToken();
    const headers = { authorization: `Bearer ${token}` };
    await app.request('https://m.example/api/count', { method: 'POST', headers }, env);
    const res = await app.request('https://m.example/life/export', { headers }, env);
    expect(res.status).toBe(200);
    // 形状以机器校验契约为准（§5.4）：parse 即校验（version/moduleId/exportedAt/tables/files）
    const bundle = ExportBundleSchema.parse(await res.json());
    expect(bundle.version).toBe(1);
    expect(bundle.moduleId).toBe('hello');
    expect(bundle.tables.hello_counter?.rows).toEqual([{ scope: 'global', n: 1 }]);
    expect(bundle.files).toEqual([]);
  });

  it('匿名调 /life/export、/life/purge → 401 人话（#45 遗留项②，与 count 路由同规）', async () => {
    const env = await envFor();
    for (const [method, path] of [
      ['GET', '/life/export'],
      ['POST', '/life/purge'],
    ] as const) {
      const res = await app.request(`https://m.example${path}`, { method }, env);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toMatch(/jose|jwt/i);
    }
  });

  it('POST /life/purge 清空模块子域数据', async () => {
    const env = await envFor();
    const token = await makeToken();
    const headers = { authorization: `Bearer ${token}` };
    await app.request('https://m.example/api/count', { method: 'POST', headers }, env);
    const purge = await app.request('https://m.example/life/purge', { method: 'POST', headers }, env);
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
    // 身份行数据源接线：token claims 经 decodeContext 填入 who/email（与上一条验签用例呼应）。
    expect(html).toContain('sdk.decodeContext');
    expect(html).toContain('claims.name ?? claims.sub');
    expect(html).toContain('claims.email');
  });

  it('页面内 fetch/import 不用根相对路径（部署挂载在 /m/<id>/ 子路径，#14 装配前提）', async () => {
    const res = await app.request('https://m.example/');
    const html = await res.text();
    // 根相对路径在 /m/hello/ 子路径下会逃逸出模块前缀（打到实例根），必须用相对路径
    expect(html).not.toMatch(/fetch\(['"]\/api\//);
    expect(html).not.toMatch(/from ['"]\/sdk\//);
    // 相对路径形式存在（页面在 /m/hello/ 下解析为 /m/hello/api/count）
    expect(html).toMatch(/fetch\(['"]api\/count['"]/);
    expect(html).toMatch(/from ['"]\.\/sdk\/module-sdk\.esm\.js['"]/);
  });
});
