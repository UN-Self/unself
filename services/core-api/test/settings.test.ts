// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { generateInstanceKeyPair } from '../src/keys';
import { requireAdmin } from '../src/middleware/admin';
import { registerSettingsRoutes } from '../src/routes/settings';
import { createSessionToken } from '../src/session';
import type { Bindings } from '../src/index';
import { createCoreDb, type CoreTestDb } from './test-factory';

interface SettingsTestEnv {
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string };
  db: CoreTestDb;
  adminCookie: string;
  memberCookie: string;
}

/** 独立 Hono 实例 + admin 守卫自建挂载（不依赖组合根接线）。 */
function settingsApp(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use('/api/admin/*', requireAdmin());
  registerSettingsRoutes(app);
  return app;
}

/** 真 users 表 + 两个签名会话，权限真值始终来自同一 SQLite 库。 */
async function envFor(): Promise<SettingsTestEnv> {
  const pair = await generateInstanceKeyPair();
  const db = createCoreDb();
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, email, role) VALUES (?, ?, ?, ?, ?, ?)',
    'u_admin',
    'https://idp.example.com',
    'admin-sub',
    '管理',
    'admin@example.com',
    'admin',
  );
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, email, role) VALUES (?, ?, ?, ?, ?, ?)',
    'u_member',
    'https://idp.example.com',
    'member-sub',
    '成员',
    'member@example.com',
    'user',
  );
  const adminToken = await createSessionToken(
    { uid: 'u_admin', iss: 'https://idp.example.com', sub: 'admin-sub', name: '管理' },
    pair.privateKeyPem,
  );
  const memberToken = await createSessionToken(
    { uid: 'u_member', iss: 'https://idp.example.com', sub: 'member-sub', name: '成员' },
    pair.privateKeyPem,
  );
  return {
    env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem },
    db,
    adminCookie: `unself_session=${adminToken}`,
    memberCookie: `unself_session=${memberToken}`,
  };
}

async function putJson(
  app: Hono<{ Bindings: Bindings }>,
  body: string,
  cookie: string,
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string },
): Promise<Response> {
  return app.request(
    'https://team.example.com/api/admin/settings',
    { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body },
    env,
  );
}

/** 样例库配置：OIDC 四键 + 单条 mail JSON（含两段消费者各自字段）。 */
function seedSampleConfig(db: CoreTestDb, mail: Record<string, unknown> = {}): void {
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'oidc_issuer', 'https://idp.example.com');
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'oidc_client_id', 'client-1');
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'oidc_client_secret', 'super-secret');
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'oidc_scope', 'openid profile email');
  db.run(
    'INSERT INTO instance_config (key, value) VALUES (?, ?)',
    'mail',
    JSON.stringify({
      baseUrl: 'https://mail.example.com',
      apiKey: 'api-key',
      domain: 'example.com',
      host: 'smtp.example.com',
      port: 2525,
      username: 'mailer',
      password: 'smtp-pass',
      from: 'noreply@example.com',
      ...mail,
    }),
  );
}

const EMPTY_SETTINGS = {
  oidc: { issuer: '', clientId: '', clientSecret: '', scope: '' },
  mail: {
    baseUrl: '',
    apiKey: '',
    domain: '',
    host: '',
    port: '',
    username: '',
    password: '',
    from: '',
  },
};

describe('实例设置查看/编辑（#17）', () => {
  it('管理员 GET 返回两段全量形状并脱敏密钥；未配置时全空串', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    const res = await app.request(
      'https://team.example.com/api/admin/settings',
      { headers: { cookie: adminCookie } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      oidc: {
        issuer: 'https://idp.example.com',
        clientId: 'client-1',
        clientSecret: '***',
        scope: 'openid profile email',
      },
      mail: {
        baseUrl: 'https://mail.example.com',
        apiKey: '***',
        domain: 'example.com',
        host: 'smtp.example.com',
        port: 2525,
        username: 'mailer',
        password: '***',
        from: 'noreply@example.com',
      },
    });

    const empty = await envFor();
    const emptyRes = await app.request(
      'https://team.example.com/api/admin/settings',
      { headers: { cookie: empty.adminCookie } },
      empty.env,
    );
    expect(emptyRes.status).toBe(200);
    expect(await emptyRes.json()).toEqual(EMPTY_SETTINGS);

    // mail 段 JSON 解析失败 → 按全空对象处理，不 500。
    const broken = await envFor();
    broken.db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'mail', '{not json');
    const brokenRes = await app.request(
      'https://team.example.com/api/admin/settings',
      { headers: { cookie: broken.adminCookie } },
      broken.env,
    );
    expect(brokenRes.status).toBe(200);
    expect(await brokenRes.json()).toEqual(EMPTY_SETTINGS);
  });

  it('PUT 改 issuer + host + port 生效；clientSecret 传 *** 时旧真值不变', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    const res = await putJson(
      app,
      JSON.stringify({
        oidc: { issuer: 'https://new-idp.example.com', clientSecret: '***' },
        mail: { host: 'smtp2.example.com', port: 587 },
      }),
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const settings = (await (
      await app.request(
        'https://team.example.com/api/admin/settings',
        { headers: { cookie: adminCookie } },
        env,
      )
    ).json()) as { oidc: Record<string, unknown>; mail: Record<string, unknown> };
    expect(settings.oidc.issuer).toBe('https://new-idp.example.com');
    expect(settings.oidc.clientSecret).toBe('***');
    expect(settings.mail.host).toBe('smtp2.example.com');
    expect(settings.mail.port).toBe(587);
    expect(settings.mail.baseUrl).toBe('https://mail.example.com');

    // 脱敏只是视图：库里 clientSecret 真值仍在。
    expect(
      db.first<{ value: string }>('SELECT value FROM instance_config WHERE key = ?', 'oidc_client_secret'),
    ).toEqual({ value: 'super-secret' });
  });

  it('PUT mail 单字段走合并语义，其余 mail 字段保持原值', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    const res = await putJson(
      app,
      JSON.stringify({ mail: { apiKey: 'new-key' } }),
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const settings = (await (
      await app.request(
        'https://team.example.com/api/admin/settings',
        { headers: { cookie: adminCookie } },
        env,
      )
    ).json()) as { mail: Record<string, unknown> };
    expect(settings.mail).toEqual({
      baseUrl: 'https://mail.example.com',
      apiKey: '***',
      domain: 'example.com',
      host: 'smtp.example.com',
      port: 2525,
      username: 'mailer',
      password: '***',
      from: 'noreply@example.com',
    });

    // 合并写回只换了 apiKey，库里其余 mail 字段原样。
    const stored = JSON.parse(
      db.first<{ value: string }>('SELECT value FROM instance_config WHERE key = ?', 'mail')!.value,
    ) as Record<string, unknown>;
    expect(stored).toEqual({
      baseUrl: 'https://mail.example.com',
      apiKey: 'new-key',
      domain: 'example.com',
      host: 'smtp.example.com',
      port: 2525,
      username: 'mailer',
      password: 'smtp-pass',
      from: 'noreply@example.com',
    });
  });

  it('PUT 空 body / 全空串 / *** → ok 且不写库、无 audit 行', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);
    const before = db.query('SELECT key, value FROM instance_config ORDER BY key');

    const noBody = await app.request(
      'https://team.example.com/api/admin/settings',
      { method: 'PUT', headers: { cookie: adminCookie } },
      env,
    );
    expect(noBody.status).toBe(200);
    expect(await noBody.json()).toEqual({ ok: true });

    const emptyObject = await putJson(app, '{}', adminCookie, env);
    expect(emptyObject.status).toBe(200);
    expect(await emptyObject.json()).toEqual({ ok: true });

    const blanks = await putJson(
      app,
      JSON.stringify({
        oidc: { issuer: '', clientId: '', clientSecret: '***', scope: '' },
        mail: { baseUrl: '', apiKey: '***', host: '', port: '', password: '' },
      }),
      adminCookie,
      env,
    );
    expect(blanks.status).toBe(200);
    expect(await blanks.json()).toEqual({ ok: true });

    expect(db.query('SELECT key, value FROM instance_config ORDER BY key')).toEqual(before);
    expect(db.query('SELECT id FROM audit_log')).toEqual([]);
  });

  it('PUT 非法 body（port 非正整数 / 字段类型错）→ 400 带 detail', async () => {
    const app = settingsApp();
    const { env, adminCookie } = await envFor();

    const badPort = await putJson(app, JSON.stringify({ mail: { port: 'abc' } }), adminCookie, env);
    expect(badPort.status).toBe(400);
    const badPortBody = (await badPort.json()) as { error: string; detail: string };
    expect(badPortBody.error).toBe('invalid settings');
    expect(typeof badPortBody.detail).toBe('string');
    expect(badPortBody.detail.length).toBeGreaterThan(0);

    const badType = await putJson(
      app,
      JSON.stringify({ oidc: { issuer: 123 } }),
      adminCookie,
      env,
    );
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as { error: string }).error).toBe('invalid settings');
  });

  it('无会话 401、普通成员 403（GET 与 PUT 一致）', async () => {
    const app = settingsApp();
    const { env, memberCookie } = await envFor();

    const anonGet = await app.request('https://team.example.com/api/admin/settings', {}, env);
    expect(anonGet.status).toBe(401);
    const anonPut = await app.request(
      'https://team.example.com/api/admin/settings',
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    );
    expect(anonPut.status).toBe(401);

    const memberGet = await app.request(
      'https://team.example.com/api/admin/settings',
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(memberGet.status).toBe(403);
    const memberPut = await putJson(app, JSON.stringify({ mail: { host: 'x' } }), memberCookie, env);
    expect(memberPut.status).toBe(403);
  });
});
