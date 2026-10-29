// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 实例设置域路由测试（#17，#340 分域）：
 * - GET 三段（oidc/stalwart/smtp）全量形状 + 密钥恒 '***'；
 * - PUT /api/admin/settings 只收 { oidc }（夹带 mail 键被忽略不落库）；
 * - PUT /api/admin/settings/mail-stalwart / mail-smtp 整键读-改-写、互不产生对方键；
 * - D5 fail-closed：enabled 必填恒布尔；enabled:true 必填不全 → 400 拒落库；
 * - #100：邮件文本空串删键，密钥空串 / *** 保持，值不变不写库。
 * 断言打在行为上（HTTP 状态/响应体/库中真实行），不碰内部调用计数。
 */
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

async function getSettings(
  app: Hono<{ Bindings: Bindings }>,
  cookie: string,
  env: SettingsTestEnv['env'],
): Promise<Response> {
  return app.request('https://team.example.com/api/admin/settings', { headers: { cookie } }, env);
}

async function putJson(
  app: Hono<{ Bindings: Bindings }>,
  path: string,
  body: unknown,
  cookie: string,
  env: SettingsTestEnv['env'],
): Promise<Response> {
  return app.request(
    `https://team.example.com${path}`,
    {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env,
  );
}

/** 读取库中单个 instance_config 值（JSON 段直读断言）。 */
function storedValue(db: CoreTestDb, key: string): string | undefined {
  return db.first<{ value: string }>('SELECT value FROM instance_config WHERE key = ?', key)?.value;
}

/** 审计 settings_updated 按 target 计数。 */
function auditCount(db: CoreTestDb, target: string): number {
  return db.first<{ count: number }>(
    "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'settings_updated' AND target = ?",
    target,
  )!.count;
}

/** 完整 stalwart 段夹具（enabled 可覆盖）。 */
const STALWART_FULL = {
  enabled: true,
  baseUrl: 'https://mail.example.com',
  apiKey: 'api-key',
  domain: 'example.com',
  portalUrl: 'https://mail.example.com/portal',
};

/** 完整 smtp 段夹具（enabled 可覆盖）。 */
const SMTP_FULL = {
  enabled: true,
  host: 'smtp.example.com',
  port: 2525,
  username: 'mailer',
  password: 'smtp-pass',
  from: 'noreply@example.com',
};

/** 样例库配置：OIDC 四键 + 两条独立 mail 段（#340 分域后路由只读新键）。 */
function seedSampleConfig(
  db: CoreTestDb,
  stalwart: Record<string, unknown> = {},
  smtp: Record<string, unknown> = {},
): void {
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'oidc_issuer', 'https://idp.example.com');
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'oidc_client_id', 'client-1');
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'oidc_client_secret', 'super-secret');
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'oidc_scope', 'openid profile email');
  db.run(
    'INSERT INTO instance_config (key, value) VALUES (?, ?)',
    'mail_stalwart',
    JSON.stringify({ ...STALWART_FULL, ...stalwart }),
  );
  db.run(
    'INSERT INTO instance_config (key, value) VALUES (?, ?)',
    'mail_smtp',
    JSON.stringify({ ...SMTP_FULL, ...smtp }),
  );
}

const EMPTY_SETTINGS = {
  oidc: { issuer: '', clientId: '', clientSecret: '', scope: '' },
  stalwart: { enabled: false, baseUrl: '', apiKey: '', domain: '', portalUrl: '' },
  smtp: { enabled: false, host: '', port: '', username: '', password: '', from: '' },
};

const FULL_SETTINGS = {
  oidc: {
    issuer: 'https://idp.example.com',
    clientId: 'client-1',
    clientSecret: '***',
    scope: 'openid profile email',
  },
  stalwart: {
    enabled: true,
    baseUrl: 'https://mail.example.com',
    apiKey: '***',
    domain: 'example.com',
    portalUrl: 'https://mail.example.com/portal',
  },
  smtp: {
    enabled: true,
    host: 'smtp.example.com',
    port: 2525,
    username: 'mailer',
    password: '***',
    from: 'noreply@example.com',
  },
};

describe('实例设置查看（#340 三段形状）', () => {
  it('管理员 GET 返回三段全量形状并脱敏密钥；未配置时全空串且 enabled:false', async () => {
    const app = settingsApp();
    const { env, adminCookie } = await envFor();
    const seeded = await envFor();
    seedSampleConfig(seeded.db);

    const res = await getSettings(app, seeded.adminCookie, seeded.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FULL_SETTINGS);

    const empty = await getSettings(app, adminCookie, env);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual(EMPTY_SETTINGS);
  });

  it('密钥铁律：GET 恒回 ***；库中真值不受脱敏影响（apiKey 与 smtp password、oidc clientSecret）', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    const body = (await (await getSettings(app, adminCookie, env)).json()) as {
      oidc: { clientSecret: string };
      stalwart: { apiKey: string };
      smtp: { password: string };
    };
    expect(body.oidc.clientSecret).toBe('***');
    expect(body.stalwart.apiKey).toBe('***');
    expect(body.smtp.password).toBe('***');
    expect(JSON.stringify(body)).not.toContain('super-secret');
    expect(JSON.stringify(body)).not.toContain('api-key');
    expect(JSON.stringify(body)).not.toContain('smtp-pass');

    expect(storedValue(db, 'oidc_client_secret')).toBe('super-secret');
    expect(JSON.parse(storedValue(db, 'mail_stalwart')!)).toMatchObject({ apiKey: 'api-key' });
    expect(JSON.parse(storedValue(db, 'mail_smtp')!)).toMatchObject({ password: 'smtp-pass' });
  });

  it('无行/损坏段：该段 enabled:false、其余空串，不 500（stolwart 损坏不影响 smtp 段照常返回）', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'mail_stalwart', '{not json');
    db.run(
      'INSERT INTO instance_config (key, value) VALUES (?, ?)',
      'mail_smtp',
      JSON.stringify(SMTP_FULL),
    );

    const res = await getSettings(app, adminCookie, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stalwart: Record<string, unknown>; smtp: Record<string, unknown> };
    expect(body.stalwart).toEqual({
      enabled: false,
      baseUrl: '',
      apiKey: '',
      domain: '',
      portalUrl: '',
    });
    expect(body.smtp.enabled).toBe(true);
    expect(body.smtp.host).toBe('smtp.example.com');
  });
});

describe('PUT /api/admin/settings（只收 oidc，#340 删 mail 键）', () => {
  it('改 issuer 生效；clientSecret 传 *** 时旧真值不变；审计 target=oidc', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    const res = await putJson(
      app,
      '/api/admin/settings',
      { oidc: { issuer: 'https://new-idp.example.com', clientSecret: '***' } },
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const body = (await (await getSettings(app, adminCookie, env)).json()) as {
      oidc: Record<string, unknown>;
    };
    expect(body.oidc.issuer).toBe('https://new-idp.example.com');
    expect(body.oidc.clientSecret).toBe('***');
    expect(storedValue(db, 'oidc_client_secret')).toBe('super-secret');
    expect(auditCount(db, 'oidc')).toBe(1);
  });

  it('body 夹带 mail/stalwart/smtp 键 → 直接忽略，不落库（#340 宽松校验惯例）', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    const before = db.query('SELECT key, value FROM instance_config ORDER BY key');

    const res = await putJson(
      app,
      '/api/admin/settings',
      {
        oidc: { scope: 'openid email' },
        mail: { host: 'evil.example.com', enabled: true },
        stalwart: { enabled: true, baseUrl: 'https://evil.example.com', apiKey: 'k', domain: 'evil.com' },
        smtp: { enabled: true, host: 'evil.example.com', port: 25, username: 'u', password: 'p', from: 'e@x.com' },
      },
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // 只有 oidc_scope 变了：mail 键既不新建也不改写，其余行原样。
    const after = db.query('SELECT key, value FROM instance_config ORDER BY key');
    expect(after.filter((row) => String(row.key).startsWith('mail'))).toEqual([]);
    const changed = after.filter(
      (row) => !before.some((b) => b.key === row.key && b.value === row.value),
    );
    expect(changed.map((row) => row.key)).toEqual(['oidc_scope']);
    expect(auditCount(db, 'oidc')).toBe(1);
  });

  it('PUT 空 body / {} / 全空串 / *** → ok 且不写库、无审计行', async () => {
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

    const emptyObject = await putJson(app, '/api/admin/settings', '{}', adminCookie, env);
    expect(emptyObject.status).toBe(200);
    expect(await emptyObject.json()).toEqual({ ok: true });

    const blanks = await putJson(
      app,
      '/api/admin/settings',
      { oidc: { issuer: '', clientId: '', clientSecret: '***', scope: '' } },
      adminCookie,
      env,
    );
    expect(blanks.status).toBe(200);
    expect(await blanks.json()).toEqual({ ok: true });

    expect(db.query('SELECT key, value FROM instance_config ORDER BY key')).toEqual(before);
    expect(db.query('SELECT id FROM audit_log')).toEqual([]);
  });

  it('PUT 非法 body（oidc 字段类型错）→ 400 带 detail', async () => {
    const app = settingsApp();
    const { env, adminCookie } = await envFor();
    const badType = await putJson(app, '/api/admin/settings', { oidc: { issuer: 123 } }, adminCookie, env);
    expect(badType.status).toBe(400);
    const body = (await badType.json()) as { error: string; detail: string };
    expect(body.error).toBe('invalid settings');
    expect(body.detail.length).toBeGreaterThan(0);
  });
});

describe('PUT /api/admin/settings/mail-stalwart（#340 分域 + D5）', () => {
  it('单字段合并：改 apiKey 后库中其余字段原样、真值落库', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    const res = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: true, apiKey: 'new-key' },
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(JSON.parse(storedValue(db, 'mail_stalwart')!)).toEqual({
      enabled: true,
      baseUrl: 'https://mail.example.com',
      apiKey: 'new-key',
      domain: 'example.com',
      portalUrl: 'https://mail.example.com/portal',
    });
    // 审计 target 分域。
    expect(auditCount(db, 'mail-stalwart')).toBe(1);
    expect(auditCount(db, 'oidc')).toBe(0);
  });

  it('PUT 只碰本键：成功后 instance_config 无 mail_smtp 行变化（两键互不产生）', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);
    const smtpBefore = storedValue(db, 'mail_smtp');

    const res = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: true, domain: 'new.example.com' },
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(storedValue(db, 'mail_smtp')).toBe(smtpBefore);
  });

  it('D5：enabled 缺失（非布尔）→ 400 拒落库', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);
    const before = db.query('SELECT key, value FROM instance_config ORDER BY key');

    const res = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { baseUrl: 'https://mail.example.com' },
      adminCookie,
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid settings');
    expect(db.query('SELECT key, value FROM instance_config ORDER BY key')).toEqual(before);
  });

  it('D5：enabled:true 缺 baseUrl → 400 带 detail 列缺失项，库中无新写入', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    const before = db.query('SELECT key, value FROM instance_config ORDER BY key');

    const res = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: true, apiKey: 'k', domain: 'example.com' },
      adminCookie,
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('invalid settings');
    expect(body.detail).toContain('开启邮箱管理需先配置');
    expect(body.detail).toContain('Stalwart 地址');
    // 拒落库：全表无任何新行（mail_stalwart 无行）。
    expect(db.query('SELECT key, value FROM instance_config ORDER BY key')).toEqual(before);
  });

  it('D5 脏数据：库里 baseUrl 是数字（非字符串）→ enabled:true 仍 400（类型按字段定，不按当前值猜）', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    db.run(
      'INSERT INTO instance_config (key, value) VALUES (?, ?)',
      'mail_stalwart',
      JSON.stringify({ baseUrl: 123, apiKey: 'k', domain: 'example.com' }),
    );

    const res = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: true },
      adminCookie,
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain('Stalwart 地址');
  });

  it('D5：库里已有 apiKey（新值传 ***）时 enabled:true 也算已配 → 200 落库', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    // 先存完整配置但开关关着：开启时密钥只传 ***，D5 用合并段（库里真值）判定已配。
    seedSampleConfig(db, { enabled: false });

    const res = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: true, apiKey: '***' },
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(storedValue(db, 'mail_stalwart')!)).toMatchObject({ enabled: true, apiKey: 'api-key' });
  });

  it('D5 负面语义：enabled:false 半配置 → 200 落库（false + 已填字段照存）', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();

    const res = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: false, baseUrl: 'https://mail.example.com' },
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.parse(storedValue(db, 'mail_stalwart')!)).toEqual({
      enabled: false,
      baseUrl: 'https://mail.example.com',
    });
  });

  it('#99 空保存不建段：无行 + {enabled:false} → 200 幂等、库中无行、无审计', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();

    const res = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: false },
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // 段本不存在且只要求关闭 = 默认状态（#99「空保存幂等不建段」）：不凭空造行、不写审计。
    expect(storedValue(db, 'mail_stalwart')).toBeUndefined();
    expect(auditCount(db, 'mail-stalwart')).toBe(0);
  });

  it('开关语义：关→开不丢配置；关状态下改字段保持 false；无变化不写审计', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    // 关：字段照存，密钥真值不被清也不被 MASK 覆盖。
    const off = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: false },
      adminCookie,
      env,
    );
    expect(off.status).toBe(200);
    expect(JSON.parse(storedValue(db, 'mail_stalwart')!)).toEqual({ ...STALWART_FULL, enabled: false });

    // GET：enabled:false，密钥仍回 MASK。
    const body = (await (await getSettings(app, adminCookie, env)).json()) as {
      stalwart: Record<string, unknown>;
    };
    expect(body.stalwart).toEqual({
      enabled: false,
      baseUrl: 'https://mail.example.com',
      apiKey: '***',
      domain: 'example.com',
      portalUrl: 'https://mail.example.com/portal',
    });

    // 关着改字段：enabled:false 保持、字段生效。
    const keepOff = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: false, baseUrl: 'https://mail2.example.com' },
      adminCookie,
      env,
    );
    expect(keepOff.status).toBe(200);
    expect(JSON.parse(storedValue(db, 'mail_stalwart')!)).toMatchObject({
      enabled: false,
      baseUrl: 'https://mail2.example.com',
    });

    // 再开：配置值仍在。
    const on = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: true },
      adminCookie,
      env,
    );
    expect(on.status).toBe(200);
    expect(JSON.parse(storedValue(db, 'mail_stalwart')!)).toMatchObject({
      enabled: true,
      apiKey: 'api-key',
    });
  });

  it('幂等：无变化的重复 PUT → 不写库不写审计（翻开关后原样重发）', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db, { enabled: false }); // 完整配置但开关关着

    const first = await putJson(app, '/api/admin/settings/mail-stalwart', { enabled: true }, adminCookie, env);
    expect(first.status).toBe(200);
    expect(auditCount(db, 'mail-stalwart')).toBe(1);

    const second = await putJson(app, '/api/admin/settings/mail-stalwart', { enabled: true }, adminCookie, env);
    expect(second.status).toBe(200);
    // enabled 已是现状、无字段变更：不写库不写审计
    expect(auditCount(db, 'mail-stalwart')).toBe(1);
  });

  it('portalUrl（#168/#184）：非空覆盖、空白清掉覆盖键回落推导、GET 原样回传', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    const set = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: true, portalUrl: 'https://portal.example.com/app-passwords' },
      adminCookie,
      env,
    );
    expect(set.status).toBe(200);
    expect(JSON.parse(storedValue(db, 'mail_stalwart')!)).toMatchObject({
      portalUrl: 'https://portal.example.com/app-passwords',
    });

    const clear = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: true, portalUrl: '   ' },
      adminCookie,
      env,
    );
    expect(clear.status).toBe(200);
    expect('portalUrl' in JSON.parse(storedValue(db, 'mail_stalwart')!)).toBe(false);
    // 清空改了配置，记审计
    expect(auditCount(db, 'mail-stalwart')).toBe(2);
  });
  it('清空语义（#100）：文本字段传空串 → 删键清库值、GET 回空；密钥传空串 = 保持', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db, { enabled: false });

    const cleared = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      // 前端整段回写：域名清空发空串；密钥留空发空串，必须当成不修改
      { enabled: false, baseUrl: 'https://mail.example.com', apiKey: '', domain: '' },
      adminCookie,
      env,
    );
    expect(cleared.status).toBe(200);

    const stored = JSON.parse(storedValue(db, 'mail_stalwart')!) as Record<string, unknown>;
    expect('domain' in stored, '清空必须真删键，不能保留原值').toBe(false);
    expect(stored.apiKey, '空串的密钥不是清空：密钥只写不读，留空 = 保持').toBe('api-key');
    expect(stored.baseUrl).toBe('https://mail.example.com');
    expect(auditCount(db, 'mail-stalwart')).toBe(1);

    const body = (await (await getSettings(app, adminCookie, env)).json()) as {
      stalwart: Record<string, unknown>;
    };
    expect(body.stalwart.domain).toBe('');
    expect(body.stalwart.apiKey).toBe('***');
  });

  it('清空必填字段后 enabled:true → 400 人话（清空生效后被 D5 拦下，不静默保留旧值）', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    const res = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: true, baseUrl: '', domain: 'example.com' },
      adminCookie,
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain('Stalwart 地址');
    // 400 整段不写：清空没有半途落库
    expect(JSON.parse(storedValue(db, 'mail_stalwart')!)).toMatchObject({
      baseUrl: 'https://mail.example.com',
    });
  });

  it('SMTP 清空：username/from 空串删键、port 空串删键；enabled:true 由 D5 拦成 400', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    // 关着清空：半配置可以落库
    const off = await putJson(
      app,
      '/api/admin/settings/mail-smtp',
      { enabled: false, username: '', from: '', port: '' },
      adminCookie,
      env,
    );
    expect(off.status).toBe(200);
    const stored = JSON.parse(storedValue(db, 'mail_smtp')!) as Record<string, unknown>;
    expect('username' in stored).toBe(false);
    expect('from' in stored).toBe(false);
    expect('port' in stored).toBe(false);
    expect(stored.password, '密码空串 = 保持').toBe('smtp-pass');

    // 开着且必填被清空 → 400，不再沿用旧值
    const on = await putJson(
      app,
      '/api/admin/settings/mail-smtp',
      { enabled: true, username: '', port: '' },
      adminCookie,
      env,
    );
    expect(on.status).toBe(400);
    const detail = ((await on.json()) as { detail: string }).detail;
    expect(detail).toContain('用户名');
    expect(detail).toContain('port');
  });

  it('幂等：未改动的字段照发原值 → 不算字段变化（不写库不写审计）', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    const res = await putJson(
      app,
      '/api/admin/settings/mail-stalwart',
      { enabled: true, baseUrl: 'https://mail.example.com', domain: 'example.com', portalUrl: 'https://mail.example.com/portal' },
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    // 值与库中一致：不算变化
    expect(auditCount(db, 'mail-stalwart')).toBe(0);
  });
});

describe('PUT /api/admin/settings/mail-smtp（#340 分域 + D5）', () => {
  it('改 host/port 生效；port 只收正整数；审计 target=mail-smtp', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    const res = await putJson(
      app,
      '/api/admin/settings/mail-smtp',
      { enabled: true, host: 'smtp2.example.com', port: 587 },
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const body = (await (await getSettings(app, adminCookie, env)).json()) as {
      smtp: Record<string, unknown>;
      stalwart: Record<string, unknown>;
    };
    expect(body.smtp).toEqual({
      enabled: true,
      host: 'smtp2.example.com',
      port: 587,
      username: 'mailer',
      password: '***',
      from: 'noreply@example.com',
    });
    expect(JSON.parse(storedValue(db, 'mail_smtp')!)).toMatchObject({
      host: 'smtp2.example.com',
      port: 587,
      password: 'smtp-pass',
    });
    expect(auditCount(db, 'mail-smtp')).toBe(1);
  });

  it('PUT 只碰本键：PUT mail-smtp 成功后 instance_config 无 mail_stalwart 行（两键互不产生）', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();

    const res = await putJson(
      app,
      '/api/admin/settings/mail-smtp',
      { enabled: true, host: 'smtp.example.com', port: 587, username: 'u', password: 'p', from: 'n@x.com' },
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(storedValue(db, 'mail_smtp')).toBeDefined();
    expect(storedValue(db, 'mail_stalwart')).toBeUndefined();
  });

  it('D5：enabled:true 必填不全 → 400 detail 列缺失项且拒落库；*** 算已配', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();
    seedSampleConfig(db);

    // 库里 password 已存，传 *** 视同已配
    const maskedOk = await putJson(
      app,
      '/api/admin/settings/mail-smtp',
      { enabled: true, host: 'smtp.example.com', port: 587, username: 'mailer', password: '***', from: 'noreply@example.com' },
      adminCookie,
      env,
    );
    expect(maskedOk.status).toBe(200);

    // 干净库缺 username/password/from：400 列出缺失项，库中无行
    const fresh = await envFor();
    const bad = await putJson(
      app,
      '/api/admin/settings/mail-smtp',
      { enabled: true, host: 'smtp.example.com', port: 587 },
      fresh.adminCookie,
      fresh.env,
    );
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; detail: string };
    expect(body.error).toBe('invalid settings');
    expect(body.detail).toContain('开启通知发信需先配置');
    expect(body.detail).toContain('用户名');
    expect(body.detail).toContain('密码');
    expect(body.detail).toContain('发件地址');
    expect(fresh.db.first<{ value: string }>('SELECT value FROM instance_config WHERE key = ?', 'mail_smtp')).toBeNull();
  });

  it('D5 负面语义：enabled:false 半配置 → 200 落库（false + 已填字段照存）', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();

    const res = await putJson(
      app,
      '/api/admin/settings/mail-smtp',
      { enabled: false, host: 'smtp.example.com' },
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.parse(storedValue(db, 'mail_smtp')!)).toEqual({
      enabled: false,
      host: 'smtp.example.com',
    });
  });

  it('#99 空保存不建段：无行 + {enabled:false} → 200 幂等、库中无行、无审计', async () => {
    const app = settingsApp();
    const { env, db, adminCookie } = await envFor();

    const res = await putJson(
      app,
      '/api/admin/settings/mail-smtp',
      { enabled: false },
      adminCookie,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(storedValue(db, 'mail_smtp')).toBeUndefined();
    expect(auditCount(db, 'mail-smtp')).toBe(0);
  });

  it('非法 body（port 非正整数 / enabled 非布尔）→ 400 带 detail', async () => {
    const app = settingsApp();
    const { env, adminCookie } = await envFor();

    const badPort = await putJson(
      app,
      '/api/admin/settings/mail-smtp',
      { enabled: true, port: 'abc' },
      adminCookie,
      env,
    );
    expect(badPort.status).toBe(400);
    expect(((await badPort.json()) as { error: string }).error).toBe('invalid settings');

    const badEnabled = await putJson(
      app,
      '/api/admin/settings/mail-smtp',
      { enabled: 'yes' },
      adminCookie,
      env,
    );
    expect(badEnabled.status).toBe(400);
    expect(((await badEnabled.json()) as { error: string }).error).toBe('invalid settings');
  });
});

describe('权限（GET 与 PUT 一致）', () => {
  it('无会话 401、普通成员 403', async () => {
    const app = settingsApp();
    const { env, memberCookie } = await envFor();

    const anonGet = await app.request('https://team.example.com/api/admin/settings', {}, env);
    expect(anonGet.status).toBe(401);
    const anonPut = await putJson(app, '/api/admin/settings/mail-smtp', { enabled: true }, '', env);
    expect(anonPut.status).toBe(401);

    const memberGet = await app.request(
      'https://team.example.com/api/admin/settings',
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(memberGet.status).toBe(403);
    const memberPut = await putJson(
      app,
      '/api/admin/settings/mail-smtp',
      { enabled: true },
      memberCookie,
      env,
    );
    expect(memberPut.status).toBe(403);
  });
});
