// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 跨域模块打通的行为测试（#247，决策 #63/#73）：
 * - frame-src 白名单生成/注入：未注册 origin 绝不出现（fail-closed 红灯面）；
 * - registryFrameOrigins：注册表 → origin 白名单（同域剔除/坏值跳过/停用不算）；
 * - module-api CORS：预检短路、白名单外零 ACAO、命中才放行；
 * - /api/modules/frame-origins 端点与注册表一致性。
 * 断言打在响应头/响应体（行为），不测内部调用。
 */
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { normalizeFrameOrigin, registryFrameOrigins } from '../src/registry';
import {
  htmlCsp,
  withHtmlSecurityHeaders,
} from '../src/security-headers';
import { generateInstanceKeyPair } from '../src/keys';
import { createCoreDb } from './test-factory';

const app = createApp();

function html(): Response {
  return new Response('<!doctype html><html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

describe('htmlCsp（frame-src 按白名单生成）', () => {
  it('零白名单 = 基线（仅 self），绝不出现 frame-src *', () => {
    expect(htmlCsp()).toBe(htmlCsp([]));
    expect(htmlCsp()).toContain("frame-src 'self'");
    expect(htmlCsp()).not.toMatch(/frame-src[^(;]*\*/);
  });

  it('追加白名单 origin；frame-ancestors 不变（外壳反点击劫持收敛面不变）', () => {
    const csp = htmlCsp(['https://mod.example.com', 'https://todo.example.org']);
    expect(csp).toContain("frame-src 'self' https://mod.example.com https://todo.example.org");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("default-src 'self'");
  });
});

describe('withHtmlSecurityHeaders（响应头注入 + 幂等合并）', () => {
  it('带白名单：HTML 响应的 CSP frame-src 含白名单 origin', () => {
    const res = withHtmlSecurityHeaders(html(), ['https://mod.example.com']);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("frame-src 'self' https://mod.example.com");
  });

  it('响应已带 CSP（_headers 先加）时：在原 frame-src 上合并，不推翻原策略', () => {
    const existing = "default-src 'self'; frame-src 'self'; object-src 'none'";
    const res = withHtmlSecurityHeaders(
      new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'content-security-policy': existing },
      }),
      ['https://mod.example.com'],
    );
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("frame-src 'self' https://mod.example.com");
    expect(csp).toContain("object-src 'none'");
  });

  it('JSON 响应不加头（即使带白名单）', () => {
    const res = withHtmlSecurityHeaders(
      new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      ['https://mod.example.com'],
    );
    expect(res.headers.has('content-security-policy')).toBe(false);
  });
});

describe('normalizeFrameOrigin / registryFrameOrigins（注册表 → 白名单）', () => {
  it('归一化：URL → origin；非 http(s)/垃圾 → null', () => {
    expect(normalizeFrameOrigin('https://mod.example.com/m/todo/')).toBe('https://mod.example.com');
    expect(normalizeFrameOrigin('http://localhost:8788/')).toBe('http://localhost:8788');
    expect(normalizeFrameOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeFrameOrigin('not a url')).toBeNull();
  });

  it('注册表启用模块的 entry origin 进白名单；同域 entry 被剔除；坏快照跳过', async () => {
    const db = createCoreDb();
    const upsert = (id: string, entry: string, enabled = 1): void => {
      db.run(
        'INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES (?, ?, ?, ?)',
        id,
        enabled,
        '1.0.0',
        JSON.stringify({ id, entry }),
      );
    };
    upsert('todo', 'https://todo.example.org/m/todo/');
    upsert('same', 'https://team.example.com/m/same/'); // 同域 → 不进白名单（self 已覆盖）
    upsert('disabled', 'https://off.example.com/', 0); // 停用 → 不进白名单
    db.run(
      "INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES ('broken', 1, '1.0.0', '{not json')",
    );
    const origins = await registryFrameOrigins(db.d1, { selfOrigin: 'https://team.example.com' });
    expect(origins).toEqual(['https://todo.example.org']);
  });
});

describe('GET /api/modules/frame-origins（外壳动态 CSP 数据源）', () => {
  it('匿名可读（同 /api/modules 口径），返回启用模块 entry origin；注册变化后即时反映', async () => {
    const pair = await generateInstanceKeyPair();
    const { createSessionToken } = await import('../src/session');
    const token = await createSessionToken(
      { uid: 'u_admin', iss: 'https://idp', sub: 'sub-admin', name: 'admin' },
      pair.privateKeyPem,
    );
    const db = createCoreDb();
    db.run(
      'INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)',
      'u_admin',
      'https://idp',
      'sub-admin',
      '管理',
      'admin',
    );
    const env = { JWT_PRIVATE_KEY: pair.privateKeyPem, CORE_DB: db.d1 };
    const cookie = `unself_session=${token}`;

    const before = await app.request('https://t.example/api/modules/frame-origins', { headers: { cookie } }, env);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual([]);

    const reg = await app.request(
      'https://t.example/api/admin/modules',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'todo',
          enabled: true,
          manifest: {
            id: 'todo',
            route: '/m/todo',
            entry: 'https://todo.example.org/',
            runtimes: ['external'],
            version: '1.0.0',
          },
        }),
      },
      env,
    );
    expect(reg.status).toBe(201);

    const after = await app.request('https://t.example/api/modules/frame-origins', { headers: { cookie } }, env);
    expect(await after.json()).toEqual(['https://todo.example.org']);
  });
});


/** 造一个带 admin 会话 Cookie 的环境（CORS/注册面测试共用）。 */
async function envWithAdmin() {
  const pair = await generateInstanceKeyPair();
  const { createSessionToken } = await import('../src/session');
  const token = await createSessionToken(
    { uid: 'u_admin', iss: 'https://idp', sub: 'sub-admin', name: 'admin' },
    pair.privateKeyPem,
  );
  const db = createCoreDb();
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)',
    'u_admin',
    'https://idp',
    'sub-admin',
    '管理',
    'admin',
  );
  return { env: { JWT_PRIVATE_KEY: pair.privateKeyPem, CORE_DB: db.d1 }, cookie: `unself_session=${token}` };
}

/** 以管理员身份注册一个 external 模块（entry 即给定 origin）。 */
function regExternal(env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string }, cookie: string, origin: string) {
  return app.request(
    'https://t.example/api/admin/modules',
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'todo',
        enabled: true,
        manifest: { id: 'todo', route: '/m/todo', entry: origin, runtimes: ['external'], version: '1.0.0' },
      }),
    },
    env,
  );
}

describe('module-api CORS（注册表白名单，#63/#73）', () => {


  it('未注册 origin：预检 204 但零 ACAO 头（浏览器拦；服务端不配合放行）——红灯面', async () => {
    const { env, cookie } = await envWithAdmin();
    await regExternal(env, cookie, 'https://registered.example.com');
    const res = await app.request(
      'https://t.example/api/module-api/storage/k',
      { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } },
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('已注册 origin：预检 204 + ACAO=该 origin + 收敛的 Allow 头', async () => {
    const { env, cookie } = await envWithAdmin();
    await regExternal(env, cookie, 'https://todo.example.org');
    const res = await app.request(
      'https://t.example/api/module-api/storage/k',
      { method: 'OPTIONS', headers: { origin: 'https://todo.example.org' } },
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://todo.example.org');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
  });

  it('实际请求（无 token）：命中白名单仍给 ACAO，但 401 由 token 门禁把守', async () => {
    const { env, cookie } = await envWithAdmin();
    await regExternal(env, cookie, 'https://todo.example.org');
    const res = await app.request(
      'https://t.example/api/module-api/storage/k',
      { headers: { origin: 'https://todo.example.org' } },
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://todo.example.org');
  });

  it('未注册 origin 的实际请求：零 ACAO + 门禁照常（双保险互不替代）', async () => {
    const { env, cookie } = await envWithAdmin();
    await regExternal(env, cookie, 'https://todo.example.org');
    const res = await app.request(
      'https://t.example/api/module-api/storage/k',
      { headers: { origin: 'https://evil.example.com' } },
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('停用模块：其 origin 立即退出白名单（启停秒级生效）', async () => {
    const { env, cookie } = await envWithAdmin();
    await regExternal(env, cookie, 'https://todo.example.org');
    await app.request(
      'https://t.example/api/admin/modules/todo/toggle',
      { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"enabled":false}' },
      env,
    );
    const res = await app.request(
      'https://t.example/api/module-api/storage/k',
      { method: 'OPTIONS', headers: { origin: 'https://todo.example.org' } },
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('注册面拒绝（#63：publicUrl 强制 https 的服务端锚点）', () => {
  it('external 模块注册公网 http:// entry → 400（本地明文豁免仅限 localhost）', async () => {
    const { env, cookie } = await envWithAdmin();
    const res = await regExternal(env, cookie, 'http://todo.example.org');
    expect(res.status).toBe(400);
  });

  it('external 模块注册 https entry → 通过', async () => {
    const { env, cookie } = await envWithAdmin();
    const res = await regExternal(env, cookie, 'https://todo.example.org');
    expect(res.status).toBe(201);
  });
});
