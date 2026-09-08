// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import app from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';

/** 可记账的内存 D1 stub：实现 setup 链路用到的最小 SQL 面。 */
interface SetupDb {
  _users: Map<string, { role: string }>;
  _audit: Array<{ action: string }>;
  _config: Map<string, string>;
}

function makeDb(): D1Database & SetupDb {
  const setupTokens = new Map<string, { used_at: string | null }>();
  const config = new Map<string, string>();
  const users = new Map<string, { id: string; issuer: string; sub: string; display_name: string; role: string }>();
  const auditLog: Array<{ actor: string; action: string; target: string | null }> = [];

  const db = {
    _users: users,
    _audit: auditLog,
    _config: config,
    prepare(sql: string) {
      const chain = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          chain._args = args;
          return chain;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM instance_config')) {
            const key = chain._args[0] as string;
            return config.has(key) ? ({ value: config.get(key) } as T) : null;
          }
          if (sql.includes('FROM setup_tokens')) {
            const token = chain._args[0] as string;
            const entry = setupTokens.get(token);
            return entry ? ({ used_at: entry.used_at } as T) : null;
          }
          if (sql.includes('FROM users')) {
            return users.get(chain._args[0] as string) as T ?? null;
          }
          return null;
        },
        async all<T>() {
          // 读 instance_config 一批键（getOidcConfig 的 SELECT ... key IN (...)）
          if (sql.includes('FROM instance_config') && sql.includes('IN (')) {
            const keys = (chain._args as string[]).filter((k) => typeof k === 'string');
            const results = keys
              .filter((k) => config.has(k))
              .map((k) => ({ key: k, value: config.get(k) as string }));
            return { results: results as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (sql.startsWith('INSERT INTO setup_tokens')) {
            setupTokens.set(chain._args[0] as string, { used_at: null });
          } else if (sql.startsWith('UPDATE setup_tokens')) {
            const token = chain._args[0] as string;
            const entry = setupTokens.get(token);
            if (entry && !entry.used_at) entry.used_at = new Date().toISOString();
          } else if (sql.startsWith('INSERT INTO instance_config')) {
            config.set(chain._args[0] as string, chain._args[1] as string);
          } else if (sql.startsWith('UPDATE users')) {
            const user = users.get(chain._args[1] as string);
            if (user) user.role = chain._args[0] as string;
          } else if (sql.startsWith('INSERT INTO audit_log')) {
            auditLog.push({
              actor: chain._args[0] as string,
              action: chain._args[1] as string,
              target: (chain._args[2] as string) ?? null,
            });
          }
          return { success: true };
        },
      };
      return chain;
    },
  };
  // 预置一个用户（JIT 建档后的会话用户）
  users.set('u_1', { id: 'u_1', issuer: 'https://idp', sub: 'u-1', display_name: '黄一', role: 'user' });
  return db as unknown as D1Database & SetupDb;
}

async function envFor() {
  const pair = await generateInstanceKeyPair();
  const { createSessionToken } = await import('../src/session');
  const token = await createSessionToken({ uid: 'u_1', iss: 'https://idp', sub: 'u-1', name: '黄一' }, pair.privateKeyPem);
  return {
    JWT_PRIVATE_KEY: pair.privateKeyPem,
    cookie: `unself_session=${token}`,
  };
}

describe('setup 流程（一次性 token + 首个管理员）', () => {
  it('部署脚本生成 setup token：未激活时成功，已激活后 409 拒绝', async () => {
    const env = await envFor();
    const db = makeDb();
    const base = { ...env, CORE_DB: db };

    const res = await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; setupUrl: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.setupUrl).toBe(`/setup?token=${body.token}`);

    // 模拟已激活（手动标记）
    db._config.set('setup_done', '1');
    const again = await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, base);
    expect(again.status).toBe(409);
  });

  it('status：未激活 + 无 token → tokenValid:false；激活后 done:true', async () => {
    const env = await envFor();
    const db = makeDb();
    const base = { ...env, CORE_DB: db };
    const none = await app.request('https://team.example.com/api/setup/status', {}, base);
    expect(await none.json()).toEqual({ done: false, tokenValid: false });

    const gen = (await (await app.request(
      'https://team.example.com/api/admin/setup-token',
      { method: 'POST' },
      base,
    )).json()) as { token: string };
    const withToken = await app.request(
      `https://team.example.com/api/setup/status?token=${gen.token}`,
      {},
      base,
    );
    expect(await withToken.json()).toEqual({ done: false, tokenValid: true });

    db._config.set('setup_done', '1');
    const done = await app.request('https://team.example.com/api/setup/status', {}, base);
    expect(await done.json()).toEqual({ done: true });
  });

  it('激活全链路：校验 token + 会话 → 首个管理员诞生 → setup 封死', async () => {
    const env = await envFor();
    const db = makeDb();
    const base = { ...env, CORE_DB: db };

    // 1) 生成 token
    const gen = (await (await app.request(
      'https://team.example.com/api/admin/setup-token',
      { method: 'POST' },
      base,
    )).json()) as { token: string };

    // 2) 未登录激活 → 401 + loginUrl（#10 前端整页跳转用）
    const anon = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      { method: 'POST' },
      base,
    );
    expect(anon.status).toBe(401);
    const anonBody = (await anon.json()) as { loginUrl: string };
    expect(anonBody.loginUrl).toContain('/api/auth/login?next=');

    // 3) 会话 + token → 激活成功，用户升 admin
    const ok = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      { method: 'POST', headers: { cookie: env.cookie } },
      base,
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { ok: boolean; user: { role: string } };
    expect(okBody.ok).toBe(true);
    expect(okBody.user.role).toBe('admin');
    expect(db._users.get('u_1')?.role).toBe('admin');

    // 4) 同一 token 第二次使用被拒（验收：同一链接第二次使用被拒）
    const replay = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      { method: 'POST', headers: { cookie: env.cookie } },
      base,
    );
    // 已封死优先：先判 setup_done
    expect(replay.status).toBe(409);

    // 5) 激活后再发 token 也被拒
    const newToken = await app.request(
      'https://team.example.com/api/admin/setup-token',
      { method: 'POST' },
      base,
    );
    expect(newToken.status).toBe(409);

    // 6) 审计留痕
    const actions = (db._audit as Array<{ action: string }>).map((a) => a.action);
    expect(actions).toContain('setup_token_issued');
    expect(actions).toContain('setup_activated');
  });

  it('无效/伪造 token 激活被拒', async () => {
    const env = await envFor();
    const db = makeDb();
    const res = await app.request(
      'https://team.example.com/api/setup/activate?token=forged-token',
      { method: 'POST', headers: { cookie: env.cookie } },
      { ...env, CORE_DB: db },
    );
    expect(res.status).toBe(403);
    expect(db._users.get('u_1')?.role).toBe('user'); // 未提权
  });

  it('缺 token 回 400', async () => {
    const env = await envFor();
    const res = await app.request(
      'https://team.example.com/api/setup/activate',
      { method: 'POST', headers: { cookie: env.cookie } },
      { ...env, CORE_DB: makeDb() },
    );
    expect(res.status).toBe(400);
  });

  it('激活持久化向导录入的 OIDC 字段（instance_config + 审计），登录走表优先', async () => {
    const env = await envFor();
    const db = makeDb();
    const base = { ...env, CORE_DB: db };

    const gen = (await (await app.request(
      'https://team.example.com/api/admin/setup-token',
      { method: 'POST' },
      base,
    )).json()) as { token: string };

    const oidc = {
      issuer: 'https://idp.example.com',
      clientId: 'app-1',
      clientSecret: 's3cret',
      scope: 'openid profile email',
    };
    const ok = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      {
        method: 'POST',
        headers: { cookie: env.cookie, 'content-type': 'application/json' },
        body: JSON.stringify(oidc),
      },
      base,
    );
    expect(ok.status).toBe(200);

    // 写库：与 getOidcConfig 读取键一致的 oidc_* 四键
    expect(db._config.get('oidc_issuer')).toBe(oidc.issuer);
    expect(db._config.get('oidc_client_id')).toBe(oidc.clientId);
    expect(db._config.get('oidc_client_secret')).toBe(oidc.clientSecret);
    expect(db._config.get('oidc_scope')).toBe(oidc.scope);

    // 审计
    const actions = (db._audit as Array<{ action: string }>).map((a) => a.action);
    expect(actions).toContain('oidc_config_stored');

    // 表优先：env 无 OIDC_* 时 login 仍按 instance_config 配置走 → 302（发现文档来自表里 issuer）
    const restore = installFakeDiscovery('https://idp.example.com');
    try {
      const login = await app.request('https://team.example.com/api/auth/login', {}, base);
      expect(login.status).toBe(302);
      expect(login.headers.get('location') ?? '').toContain('https://idp.example.com');
    } finally {
      restore();
    }
  });

  it('激活 body 字段非法时忽略该字段，纯 token 激活兼容', async () => {
    const env = await envFor();
    const db = makeDb();
    const base = { ...env, CORE_DB: db };

    const gen = (await (await app.request(
      'https://team.example.com/api/admin/setup-token',
      { method: 'POST' },
      base,
    )).json()) as { token: string };

    const ok = await app.request(
      `https://team.example.com/api/setup/activate?token=${gen.token}`,
      {
        method: 'POST',
        headers: { cookie: env.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 123, clientId: '', scope: 'openid', extra: 'ignored' }),
      },
      base,
    );
    expect(ok.status).toBe(200);
    // issuer=123（非字符串）/ clientId=''（空串）→ 忽略；scope 合法 → 落库；未知键忽略
    expect(db._config.has('oidc_issuer')).toBe(false);
    expect(db._config.has('oidc_client_id')).toBe(false);
    expect(db._config.get('oidc_scope')).toBe('openid');
    expect(db._users.get('u_1')?.role).toBe('admin');
  });
});

/** 假发现文档（仅 login 需要；test-connection 的完整假 IdP 在 auth-routes.test.ts）。 */
function installFakeDiscovery(issuer: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/.well-known/openid-configuration')) {
      return new Response(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }),
        { status: 200 },
      );
    }
    throw new Error(`fake discovery: unexpected fetch ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
