// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/index';

const app = createApp();
import { generateInstanceKeyPair } from '../src/keys';
import { resetOidcCaches } from '../src/oidc';
import { consumeSetupToken, releaseSetupToken } from '../src/setup';
import { createCoreDb, type CoreTestDb } from './test-factory';

/** SQLite `datetime('now')` 落库文本语义（UTC，无 T/Z，非 ISO）。 */
const DATETIME_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

beforeEach(() => {
  // 发现文档按 issuer 进程内缓存（15 分钟 TTL）：用例间换 scopes_supported 必须重置
  resetOidcCaches();
});

/** 造带 u_1 会话 Cookie 的环境；u_1 落真 users 表（迁移 0001：issuer/sub NOT NULL 都要给）。 */
async function envFor(): Promise<{
  env: { JWT_PRIVATE_KEY: string; CORE_DB: D1Database };
  db: CoreTestDb;
  cookie: string;
}> {
  const pair = await generateInstanceKeyPair();
  const { createSessionToken } = await import('../src/session');
  const token = await createSessionToken(
    { uid: 'u_1', iss: 'https://idp', sub: 'u-1', name: '黄一' },
    pair.privateKeyPem,
  );
  const db = createCoreDb();
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)',
    'u_1',
    'https://idp',
    'u-1',
    '黄一',
    'user',
  );
  return {
    env: { JWT_PRIVATE_KEY: pair.privateKeyPem, CORE_DB: db.d1 },
    db,
    cookie: `unself_session=${token}`,
  };
}

/** 翻转 setup_done（真 SQL UPSERT；与 markSetupDone 语义一致，测试自种不走路由）。 */
function markSetupDone(db: CoreTestDb): void {
  db.run(
    "INSERT INTO instance_config (key, value) VALUES ('setup_done','1') ON CONFLICT(key) DO UPDATE SET value='1'",
  );
}

/** 模拟装配器第⑧步（#165 方案 B）：本地生成一次性 token 直插 core 库（公开签发端点已删）。
 *  与 deploy/cloudflare/src/smoke.ts 的 generateSetupToken 同形状（24B → base64url 无填充）。 */
function issueSetupToken(db: CoreTestDb): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const token = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  db.run('INSERT INTO setup_tokens (token) VALUES (?)', token);
  return token;
}

/** 合法形状的内置凭证（本文件只验 setup 门禁/建号行为；KDF 正确性由 builtin-auth.test.ts 覆盖）。 */
const BUILTIN_BODY = { username: 'boss', salt: 'AAAAAAAAAAAAAAAAAAAAAA==', proof: `${'A'.repeat(43)}=` };

describe('setup 流程（一次性 token + 首个管理员）', () => {
  it('公开签发口已删（#165）：/api/admin/setup-token 无会话 401、admin 会话 404（路由不存在）', async () => {
    const { env, db, cookie } = await envFor();
    // 无会话：/api/admin/* 已被 adminGuard 接管（旧实现显式豁免此路径 → 无门自铸 token）
    const anon = await app.request('https://team.example.com/api/admin/setup-token', { method: 'POST' }, env);
    expect(anon.status).toBe(401);
    // 有 admin 会话：路由已删 → JSON 404（端点不存在，不是降级/隐藏）
    db.run("UPDATE users SET role = 'admin' WHERE id = ?", 'u_1');
    const admin = await app.request(
      'https://team.example.com/api/admin/setup-token',
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(admin.status).toBe(404);
    expect(await admin.json()).toEqual({ error: 'not found' });
    // 两条路径都不签 token、不落审计
    expect(db.query('SELECT token FROM setup_tokens')).toEqual([]);
    expect(
      db.query<{ action: string }>("SELECT action FROM audit_log WHERE action = 'setup_token_issued'"),
    ).toEqual([]);
  });

  it('builtin-admin 门禁（#165）：无 token 403、错 token 403，均不建号不封箱', async () => {
    const { env, db } = await envFor();
    const payload = JSON.stringify(BUILTIN_BODY);

    const missing = await app.request(
      'https://team.example.com/api/setup/builtin-admin',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload },
      env,
    );
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: 'missing setup token' });

    const forged = await app.request(
      'https://team.example.com/api/setup/builtin-admin?token=forged-token',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload },
      env,
    );
    expect(forged.status).toBe(403);
    expect(await forged.json()).toEqual({ error: 'invalid or already-used setup token' });

    // 真库：未给/错 token 不建号、不封箱
    expect(db.query("SELECT * FROM users WHERE issuer = 'builtin'")).toEqual([]);
    expect(db.first("SELECT value FROM instance_config WHERE key = 'setup_done'")).toBeNull();
  });

  it('builtin-admin 正确 token → 201 建 admin 并封箱；x-setup-token 头同认（#165）', async () => {
    const { env, db } = await envFor();
    const token = issueSetupToken(db);
    const res = await app.request(
      `https://team.example.com/api/setup/builtin-admin?token=${token}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BUILTIN_BODY) },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; user: { role: string; name: string } };
    expect(body.ok).toBe(true);
    expect(body.user).toMatchObject({ role: 'admin', name: 'boss' });
    // 真库：内置 admin + 封箱 + 审计
    expect(
      db.first<{ role: string; issuer: string }>("SELECT role, issuer FROM users WHERE display_name = 'boss'"),
    ).toEqual({ role: 'admin', issuer: 'builtin' });
    expect(db.first("SELECT value FROM instance_config WHERE key = 'setup_done'")).toEqual({ value: '1' });
    expect(
      db.query<{ action: string }>("SELECT action FROM audit_log WHERE action = 'builtin_admin_created'"),
    ).toHaveLength(1);
    // #171：封箱时消费 token——used_by 记新建 admin 的 uid，used_at 非空（一次性语义落实）
    const adminRow = db.first<{ id: string }>("SELECT id FROM users WHERE display_name = 'boss'");
    const tokenRow = db.first<{ used_at: string | null; used_by: string | null }>(
      'SELECT used_at, used_by FROM setup_tokens WHERE token = ?',
      token,
    );
    expect(tokenRow?.used_at).toMatch(DATETIME_TEXT);
    expect(tokenRow?.used_by).toBe(adminRow?.id);
    expect(tokenRow?.used_by).toMatch(/^u_[0-9a-f]{32}$/);

    // 取法复用 activate：x-setup-token 头同样开门（独立实例，验证头部路径）
    const { env: env2, db: db2 } = await envFor();
    const headerToken = issueSetupToken(db2);
    const viaHeader = await app.request(
      'https://team.example.com/api/setup/builtin-admin',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-setup-token': headerToken },
        body: JSON.stringify(BUILTIN_BODY),
      },
      env2,
    );
    expect(viaHeader.status).toBe(201);
    // 头部路径同样消费并记 used_by
    const headerAdmin = db2.first<{ id: string }>("SELECT id FROM users WHERE display_name = 'boss'");
    expect(
      db2.first<{ used_at: string | null; used_by: string | null }>(
        'SELECT used_at, used_by FROM setup_tokens WHERE token = ?',
        headerToken,
      ),
    ).toMatchObject({ used_by: headerAdmin?.id });
    expect(
      db2.first<{ used_at: string | null }>('SELECT used_at FROM setup_tokens WHERE token = ?', headerToken)
        ?.used_at,
    ).toMatch(DATETIME_TEXT);
  });

  it('并发同一 token 双 builtin-admin：仅一次 201，另一次 403 已消费，只落一个 admin（#171 验收 3）', async () => {
    const { env, db } = await envFor();
    const token = issueSetupToken(db);
    const open = () =>
      app.request(
        `https://team.example.com/api/setup/builtin-admin?token=${token}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BUILTIN_BODY) },
        env,
      );
    const [a, b] = await Promise.all([open(), open()]);
    const statuses = [a.status, b.status].sort();
    // 契约：恰好一次 201；另一次是 403「invalid or already-used setup token」——不是用户名撞名 409
    // （消费在建号之前，第二请求根本走不到 UNIQUE 硬闸）
    expect(statuses).toEqual([201, 403]);
    const loser = a.status === 403 ? a : b;
    expect(await loser.json()).toEqual({ error: 'invalid or already-used setup token' });
    // 真库：只有一个内置 admin、审计仅一条，token 恰好消费一次且 used_by 指向它
    expect(db.first<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE issuer = 'builtin'")?.c).toBe(1);
    const admin = db.first<{ id: string }>("SELECT id FROM users WHERE issuer = 'builtin'");
    const tokenRow = db.first<{ used_at: string | null; used_by: string | null }>(
      'SELECT used_at, used_by FROM setup_tokens WHERE token = ?',
      token,
    );
    expect(tokenRow?.used_at).toMatch(DATETIME_TEXT);
    expect(tokenRow?.used_by).toBe(admin?.id);
    expect(
      db.query<{ action: string }>("SELECT action FROM audit_log WHERE action = 'builtin_admin_created'"),
    ).toHaveLength(1);
  });

  it('builtin-admin 撞名 409 不烧 token（#171）：软闸失败后同一 token 换名仍可 201', async () => {
    const { env, db } = await envFor();
    // 先占位一个内置账号（真行：users + builtin_credentials，软闸 JOIN 才认）
    db.run(
      "INSERT INTO users (id, issuer, sub, display_name, role, status) VALUES ('u_taken','builtin','u_taken','taken','admin','active')",
    );
    db.run("INSERT INTO builtin_credentials (user_id, username, password_hash) VALUES ('u_taken','boss','x')");
    const token = issueSetupToken(db);

    const taken = await app.request(
      `https://team.example.com/api/setup/builtin-admin?token=${token}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BUILTIN_BODY) },
      env,
    );
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: '该用户名已被占用' });
    // 撞名失败不消费 token（否则同一链接直接作废，实例卡死）
    expect(db.first('SELECT used_at, used_by FROM setup_tokens WHERE token = ?', token)).toEqual({
      used_at: null,
      used_by: null,
    });

    // 换名重试 → 201，used_by 记新 admin uid
    const retry = await app.request(
      `https://team.example.com/api/setup/builtin-admin?token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...BUILTIN_BODY, username: 'boss2' }),
      },
      env,
    );
    expect(retry.status).toBe(201);
    const admin = db.first<{ id: string }>("SELECT id FROM users WHERE display_name = 'boss2'");
    expect(db.first('SELECT used_by FROM setup_tokens WHERE token = ?', token)).toEqual({ used_by: admin!.id });
  });

  it('releaseSetupToken：仅归还自己预占的 token（used_by 不符不动），归还后回到未消费（#171 硬闸补偿）', async () => {
    const { db } = await envFor();
    const token = issueSetupToken(db);

    expect(await consumeSetupToken(db.d1, token, 'u_owner')).toBe(true);
    // 他人 uid 误放 → false，行保持已消费（不误放别人的 token）
    expect(await releaseSetupToken(db.d1, token, 'u_other')).toBe(false);
    expect(db.first('SELECT used_at, used_by FROM setup_tokens WHERE token = ?', token)).toMatchObject({
      used_by: 'u_owner',
    });
    // 本人 uid → true，used_at/used_by 双清 → token 可再次消费
    expect(await releaseSetupToken(db.d1, token, 'u_owner')).toBe(true);
    expect(db.first('SELECT used_at, used_by FROM setup_tokens WHERE token = ?', token)).toEqual({
      used_at: null,
      used_by: null,
    });
    expect(await consumeSetupToken(db.d1, token, 'u_owner')).toBe(true);
  });

  it('封箱后全端点 409（#165 验收 4）：builtin-admin / oidc-config / activate', async () => {
    const { env, db, cookie } = await envFor();
    const token = issueSetupToken(db);
    markSetupDone(db);
    const builtin = await app.request(
      `https://team.example.com/api/setup/builtin-admin?token=${token}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BUILTIN_BODY) },
      env,
    );
    expect(builtin.status).toBe(409);
    const oidc = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'https://idp.example.com', clientId: 'c', clientSecret: 's' }),
      },
      env,
    );
    expect(oidc.status).toBe(409);
    const activate = await app.request(
      `https://team.example.com/api/setup/activate?token=${token}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(activate.status).toBe(409);
    // 封箱优先于 token 门：合法未消费 token 也不建号
    expect(db.query("SELECT * FROM users WHERE issuer = 'builtin'")).toEqual([]);
  });

  it('status：未激活 + 无 token → tokenValid:false；激活后 done:true', async () => {
    const { env, db } = await envFor();
    const none = await app.request('https://team.example.com/api/setup/status', {}, env);
    expect(await none.json()).toEqual({ done: false, tokenValid: false });

    const token = issueSetupToken(db);
    const withToken = await app.request(
      `https://team.example.com/api/setup/status?token=${token}`,
      {},
      env,
    );
    expect(await withToken.json()).toEqual({ done: false, tokenValid: true });

    markSetupDone(db);
    const done = await app.request('https://team.example.com/api/setup/status', {}, env);
    expect(await done.json()).toEqual({ done: true });
  });

  it('激活全链路：校验 token + 会话 → 首个管理员诞生 → setup 封死', async () => {
    const { env, db, cookie } = await envFor();

    // 1) 装配器直插 token（#165：签发口已删）
    const token = issueSetupToken(db);

    // 2) 未登录激活 → 纯 401（#55：loginUrl 路径已删——登录在 oidc-config 落库后发起）
    const anon = await app.request(
      `https://team.example.com/api/setup/activate?token=${token}`,
      { method: 'POST' },
      env,
    );
    expect(anon.status).toBe(401);
    const anonBody = (await anon.json()) as Record<string, unknown>;
    expect(anonBody).toEqual({ error: 'authentication required' });
    expect('loginUrl' in anonBody).toBe(false);

    // 3) 会话 + token → 激活成功，用户升 admin
    const ok = await app.request(
      `https://team.example.com/api/setup/activate?token=${token}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { ok: boolean; user: { role: string } };
    expect(okBody.ok).toBe(true);
    expect(okBody.user.role).toBe('admin');
    // 真库断言：users.role 已升 admin
    expect(db.first<{ role: string }>('SELECT role FROM users WHERE id = ?', 'u_1')).toEqual({ role: 'admin' });
    // 真库断言：setup_done 已置位
    expect(
      db.first<{ value: string }>("SELECT value FROM instance_config WHERE key = 'setup_done'"),
    ).toEqual({ value: '1' });
    // 真库断言：token 已消费，used_at 是 SQLite datetime 文本（非 ISO 带 T/Z），used_by = 提权用户 uid
    const tokenRow = db.first<{ created_at: string; used_at: string | null; used_by: string | null }>(
      'SELECT created_at, used_at, used_by FROM setup_tokens WHERE token = ?',
      token,
    );
    expect(tokenRow).not.toBeNull();
    expect(tokenRow!.created_at).toMatch(DATETIME_TEXT);
    expect(tokenRow!.used_at).toMatch(DATETIME_TEXT);
    expect(tokenRow!.used_by).toBe('u_1');

    // 4) 同一 token 第二次使用被拒（验收：同一链接第二次使用被拒）
    const replay = await app.request(
      `https://team.example.com/api/setup/activate?token=${token}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    // 已封死优先：先判 setup_done
    expect(replay.status).toBe(409);

    // 5) 封箱后签发口仍不存在：无会话被 adminGuard 拦下（豁免已删，#165）
    const sealedPort = await app.request(
      'https://team.example.com/api/admin/setup-token',
      { method: 'POST' },
      env,
    );
    expect(sealedPort.status).toBe(401);

    // 6) 审计留痕（真 audit_log 表 action 列；签发审计随端点一并退场）
    const actions = db.query<{ action: string }>('SELECT action FROM audit_log').map((a) => a.action);
    expect(actions).toContain('setup_activated');
    expect(actions).not.toContain('setup_token_issued');
  });

  it('无效/伪造 token 激活被拒', async () => {
    const { env, db, cookie } = await envFor();
    const res = await app.request(
      'https://team.example.com/api/setup/activate?token=forged-token',
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(res.status).toBe(403);
    expect(db.first<{ role: string }>('SELECT role FROM users WHERE id = ?', 'u_1')).toEqual({ role: 'user' }); // 未提权
  });

  it('缺 token 回 400', async () => {
    const { env, cookie } = await envFor();
    const res = await app.request(
      'https://team.example.com/api/setup/activate',
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('oidc-config：有效 token 落库审计 + 只验不消费（可重复提交改填），返回 loginUrl', async () => {
    const { env, db } = await envFor();

    const token = issueSetupToken(db);

    const oidc = {
      issuer: 'https://idp.example.com',
      clientId: 'app-1',
      clientSecret: 's3cret',
    };
    const ok = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(oidc),
      },
      env,
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { ok: boolean; loginUrl: string };
    expect(okBody.ok).toBe(true);
    // loginUrl：next 带回带 token 的 setup 页（直线流程第二步）
    const loginUrl = new URL(okBody.loginUrl);
    expect(`${loginUrl.origin}${loginUrl.pathname}`).toBe('https://team.example.com/api/auth/login');
    expect(loginUrl.searchParams.get('next')).toBe(`/setup?token=${token}`);

    // 真库：与 getOidcConfig 读取键一致的 oidc_* 键已落库（无 scope 字段 → 不写 scope，登录时默认三件）
    const configValue = (key: string) =>
      db.first<{ value: string }>('SELECT value FROM instance_config WHERE key = ?', key)?.value ?? null;
    expect(configValue('oidc_issuer')).toBe(oidc.issuer);
    expect(configValue('oidc_client_id')).toBe(oidc.clientId);
    expect(configValue('oidc_client_secret')).toBe(oidc.clientSecret);
    expect(configValue('oidc_scope')).toBeNull();
    // 真库：token 未消费（只验不消费）
    expect(
      db.first<{ used_at: string | null }>('SELECT used_at FROM setup_tokens WHERE token = ?', token),
    ).toEqual({ used_at: null });

    // 改填可重复提交：同一 token 再提交新值 → 覆盖 + 仍不消费
    const again = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...oidc, issuer: 'https://new-idp.example.com' }),
      },
      env,
    );
    expect(again.status).toBe(200);
    expect(configValue('oidc_issuer')).toBe('https://new-idp.example.com');
    expect(
      db.first<{ used_at: string | null }>('SELECT used_at FROM setup_tokens WHERE token = ?', token),
    ).toEqual({ used_at: null });

    // 审计（真 audit_log 表）
    const actions = db.query<{ action: string }>('SELECT action FROM audit_log').map((a) => a.action);
    expect(actions.filter((a) => a === 'oidc_config_stored').length).toBeGreaterThan(0);
  });

  it('oidc-config：无效/已消费 token 拒，缺 token/缺字段 400，封箱后 409', async () => {
    const { env, db, cookie } = await envFor();

    // 无效 token → 403，不落库
    const forged = await app.request(
      'https://team.example.com/api/setup/oidc-config?token=forged-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'https://idp.example.com', clientId: 'c', clientSecret: 's' }),
      },
      env,
    );
    expect(forged.status).toBe(403);
    expect(db.first('SELECT value FROM instance_config WHERE key = ?', 'oidc_issuer')).toBeNull();

    // 缺 token → 400
    const noToken = await app.request(
      'https://team.example.com/api/setup/oidc-config',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'https://idp.example.com', clientId: 'c', clientSecret: 's' }),
      },
      env,
    );
    expect(noToken.status).toBe(400);

    // 缺字段 → 400（用合法未消费 token：token 门禁在 body 校验之前，先过门禁）
    const token = issueSetupToken(db);
    const missing = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'https://idp.example.com' }),
      },
      env,
    );
    expect(missing.status).toBe(400);
    expect(db.first('SELECT value FROM instance_config WHERE key = ?', 'oidc_issuer')).toBeNull();

    // 一个合法生成的 token 先激活（消费），随后 oidc-config 再提交 → 403
    const token2 = issueSetupToken(db);
    const activate = await app.request(
      `https://team.example.com/api/setup/activate?token=${token2}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(activate.status).toBe(200);
    const afterConsume = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${token2}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'https://idp.example.com', clientId: 'c', clientSecret: 's' }),
      },
      env,
    );
    // 封箱优先：setup_done 已置位 → 409（两端点同响应）
    expect(afterConsume.status).toBe(409);
  });

  it('直线流程全链：oidc-config 落库 → 登录可通（表优先）→ 回 setup 激活提权封箱', async () => {
    const { env, db, cookie } = await envFor();

    const token = issueSetupToken(db);

    // 第一步：带 token 提交向导字段（env 无 OIDC_* 兜底——全新部署真实场景）
    const oidc = {
      issuer: 'https://idp.example.com',
      clientId: 'app-1',
      clientSecret: 's3cret',
    };
    const save = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(oidc),
      },
      env,
    );
    expect(save.status).toBe(200);

    // 第二步：未登录也能发起登录（配置来自表，不再 503）
    const restore = installFakeDiscovery(oidc.issuer);
    try {
      const login = await app.request('https://team.example.com/api/auth/login', {}, env);
      expect(login.status).toBe(302);
      const loc = new URL(login.headers.get('location') ?? '');
      expect(`${loc.origin}${loc.pathname}`).toBe('https://idp.example.com/authorize');
      expect(loc.searchParams.get('client_id')).toBe(oidc.clientId);
      expect(loc.searchParams.get('scope')).toBe('openid profile email'); // 发现文档无 scopes_supported → 维持三件
    } finally {
      restore();
    }

    // 第三步：登录回来带会话 + token → 激活提权封箱
    const activate = await app.request(
      `https://team.example.com/api/setup/activate?token=${token}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(activate.status).toBe(200);
    const body = (await activate.json()) as { ok: boolean; user: { role: string } };
    expect(body.ok).toBe(true);
    expect(body.user.role).toBe('admin');
    expect(db.first<{ role: string }>('SELECT role FROM users WHERE id = ?', 'u_1')).toEqual({ role: 'admin' });
    expect(db.first('SELECT value FROM instance_config WHERE key = ?', 'setup_done')).toEqual({ value: '1' });
    expect(
      db.first<{ used_at: string | null; used_by: string | null }>(
        'SELECT used_at, used_by FROM setup_tokens WHERE token = ?',
        token,
      ),
    ).toMatchObject({ used_by: 'u_1' });

    // 封箱后：oidc-config / activate 全 409；公开签发口不存在（无会话 → adminGuard 401）
    const after = await app.request(
      `https://team.example.com/api/setup/oidc-config?token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(oidc),
      },
      env,
    );
    expect(after.status).toBe(409);
    const replay = await app.request(
      `https://team.example.com/api/setup/activate?token=${token}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(replay.status).toBe(409);
    const sealedPort = await app.request(
      'https://team.example.com/api/admin/setup-token',
      { method: 'POST' },
      env,
    );
    expect(sealedPort.status).toBe(401);
  });

  it('scope：按 discovery scopes_supported 过滤（Stalwart 无 email → 只发 openid；交集空只 openid；字段缺失三件）', async () => {
    const cases: Array<{ scopes?: string[]; expected: string }> = [
      // Stalwart 0.16 实测：无 profile/email，只有 openid 进交集
      { scopes: ['openid', 'offline_access', 'mail', 'contacts', 'calendars'], expected: 'openid' },
      // 交集为空 → 只发 openid
      { scopes: ['offline_access'], expected: 'openid' },
      // scopes_supported 字段缺失 → 维持三件
      { expected: 'openid profile email' },
    ];

    for (const c of cases) {
      // 同一 issuer 的发现文档 15 分钟缓存：每种子场景都要重置才能拿到各自的 scopes_supported
      resetOidcCaches();
      const { env, db } = await envFor();
      const token = issueSetupToken(db);
      const oidc = { issuer: 'https://idp.example.com', clientId: 'app-1', clientSecret: 's3cret' };
      await app.request(
        `https://team.example.com/api/setup/oidc-config?token=${token}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(oidc),
        },
        env,
      );

      const restore = installFakeDiscovery(oidc.issuer, c.scopes);
      try {
        const login = await app.request('https://team.example.com/api/auth/login', {}, env);
        expect(login.status).toBe(302);
        const loc = new URL(login.headers.get('location') ?? '');
        expect(loc.searchParams.get('scope')).toBe(c.expected);
      } finally {
        restore();
      }
    }
  });

  it('并发双激活同一 token：仅一次成功（consumeSetupToken 原子化）', async () => {
    const { env, db, cookie } = await envFor();

    const token = issueSetupToken(db);

    const activate = () =>
      app.request(
        `https://team.example.com/api/setup/activate?token=${token}`,
        { method: 'POST', headers: { cookie } },
        env,
      );
    const [a, b] = await Promise.all([activate(), activate()]);
    const statuses = [a.status, b.status];

    // 契约：同一 token 并发双激活只有一次成功；另一次被拒（403 已使用 / 409 已封死）
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 403 || s === 409)).toHaveLength(1);

    // 真库：只有一次激活落痕——setup_done 置位、升管理员、审计仅一条 setup_activated
    expect(
      db.query<{ value: string }>("SELECT value FROM instance_config WHERE key = 'setup_done'"),
    ).toEqual([{ value: '1' }]);
    expect(db.first<{ role: string }>('SELECT role FROM users WHERE id = ?', 'u_1')).toEqual({ role: 'admin' });
    expect(
      db.query<{ action: string }>("SELECT action FROM audit_log WHERE action = 'setup_activated'"),
    ).toHaveLength(1);
  });

  // --- 守护用例（审核 T1：查询列 ↔ 建表列错位即红） ------------------------

  it('守护：setup 相关表列与迁移建表一致（幻影列/漏列即红）', async () => {
    const { db } = await envFor();
    expect(db.columns('instance_config')).toEqual(['key', 'value', 'updated_at']);
    expect(db.columns('setup_tokens')).toEqual(['token', 'created_at', 'used_at', 'used_by']);
    expect(db.columns('users')).toEqual([
      'id',
      'issuer',
      'sub',
      'display_name',
      'email',
      'personal_email',
      'role',
      'status',
      'created_at',
    ]);
  });

  it('守护：激活全链路跑完后各行 SELECT * 列集合 == columns()', async () => {
    const { env, db, cookie } = await envFor();
    const token = issueSetupToken(db);
    const ok = await app.request(
      `https://team.example.com/api/setup/activate?token=${token}`,
      { method: 'POST', headers: { cookie } },
      env,
    );
    expect(ok.status).toBe(200);

    const expectShape = (table: string, row: Record<string, unknown> | null) => {
      expect(Object.keys(row ?? {}).sort()).toEqual([...db.columns(table)].sort());
    };
    expectShape('users', db.first('SELECT * FROM users WHERE id = ?', 'u_1'));
    expectShape('setup_tokens', db.first('SELECT * FROM setup_tokens WHERE token = ?', token));
    expectShape('instance_config', db.first("SELECT * FROM instance_config WHERE key = 'setup_done'"));
    const auditRows = db.query('SELECT * FROM audit_log');
    expect(auditRows.length).toBeGreaterThan(0);
    for (const row of auditRows) {
      expectShape('audit_log', row);
    }
  });

  it('守护：真 schema 约束生效（setup_tokens 重复 token 必须抛错）', async () => {
    const { db } = await envFor();
    db.run('INSERT INTO setup_tokens (token) VALUES (?)', 'once-token');
    // 主键真生效：同一 token 二次插入违反 PK → 抛错
    expect(() => db.run('INSERT INTO setup_tokens (token) VALUES (?)', 'once-token')).toThrow();
    // 注：NULL token 不抛错——SQLite 对未声明 NOT NULL 的 TEXT PRIMARY KEY 允许 NULL
    // （迁移 0002 的 token 列缺 NOT NULL；见报告：真实 schema 发现）。
  });
});

/** 假发现文档（仅 login 需要；test-connection 的完整假 IdP 在 auth-routes.test.ts）。
 *  scopes: 传入则产出 scopes_supported；不传则字段缺失（对应「维持三件」分支）。 */
function installFakeDiscovery(issuer: string, scopes?: string[]) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/.well-known/openid-configuration')) {
      const metadata: Record<string, unknown> = {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      };
      if (scopes !== undefined) {
        metadata.scopes_supported = scopes;
      }
      return new Response(JSON.stringify(metadata), { status: 200 });
    }
    throw new Error(`fake discovery: unexpected fetch ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
