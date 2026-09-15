// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #182 行为测试：dev-entry 的进程内单例 fake——批准（createAccount）与
 * 激活（resetPassword）是两个独立 HTTP 请求，第二个请求必须还能看到第一个
 * 请求写的账户（生产默认装配每请求新建 fake，这里锁定 dev 入口不走那条路）。
 *
 * 断言全部打在用户可见行为（HTTP 状态 + 库行），不打实现。
 */
import { describe, expect, it } from 'vitest';

import { generateInstanceKeyPair } from '../src/keys';
import { hashOneTimeToken } from '../src/one-time-token';
import { createSessionToken } from '../src/session';
import { createCoreDb, type CoreTestDb } from './test-factory';

/** 完整实例 mail 段（provisioner 才会装配；值随意，fake 不发网络）。 */
const MAIL_CONFIG = {
  baseUrl: 'https://mail.example.com',
  apiKey: 'k',
  domain: 'example.com',
  host: 'smtp.example.com',
  port: 465,
  username: 'u',
  password: 'p',
  from: 'no-reply@example.com',
};

interface DevEnv {
  CORE_DB: D1Database;
  JWT_PRIVATE_KEY: string;
}

async function fixture(): Promise<{ db: CoreTestDb; env: DevEnv; adminCookie: string; app: { fetch: typeof fetch } }> {
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
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'mail', JSON.stringify(MAIL_CONFIG));
  const adminCookie = `unself_session=${await createSessionToken(
    { uid: 'u_admin', iss: 'https://idp.example.com', sub: 'admin-sub', name: '管理' },
    pair.privateKeyPem,
  )}`;
  // 与 wrangler dev 同构：加载 dev-entry 拿模块级 app（单例 fake 随之固化在模块里）
  const devEntry = await import('./dev-entry');
  return {
    db,
    env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem },
    adminCookie,
    app: devEntry.default,
  };
}

async function request(
  app: { fetch: typeof fetch },
  env: DevEnv,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return app.fetch(new Request(`https://team.example.com${path}`, init), env, {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  });
}

describe('#182 dev-entry 单例 fake：完整形态第 8 步（跨请求）', () => {
  it('批准请求的假开户，在后续激活请求的假改密里仍可见（两请求同一内存账户）', async () => {
    const { db, env, adminCookie, app } = await fixture();

    // 建邀请 → 填表（请求 1、2）
    const created = await request(app, env, '/api/admin/invites', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(201);
    const { inviteUrl } = (await created.json()) as { inviteUrl: string };
    const inviteToken = inviteUrl.split('/invite/')[1]!;
    const tokenHash = await hashOneTimeToken(inviteToken);

    const applied = await request(app, env, `/api/invite/${inviteToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: '王小米',
        emailPrefix: 'wangxm',
        personalEmail: 'wangxm@personal.example',
      }),
    });
    expect(applied.status).toBe(200);

    // 请求 3：批准 → 假 provisioner 开户 wangxm@example.com（内存 Map 写进单例）
    const approved = await request(app, env, `/api/admin/invites/${tokenHash}/approve`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    });
    expect(approved.status).toBe(200);

    // 请求 4：邀请页 claim 自助重签激活链接（同属完整形态第 7-8 步动线）
    const claimed = await request(app, env, `/api/invite/${inviteToken}/claim-activation`, {
      method: 'POST',
    });
    expect(claimed.status).toBe(200);
    const { activationUrl } = (await claimed.json()) as { activationUrl: string };
    const activationToken = activationUrl.split('/activate/')[1]!;

    // 请求 5（第 8 步本体）：设置邮箱密码——走 provisioner.resetPassword。
    // 默认装配（每请求新 fake）在此必 502「邮箱账户不存在」；dev-entry 单例必须 200。
    const activated = await request(app, env, `/api/activate/${activationToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'super-secret-1' }),
    });
    expect(activated.status).toBe(200);

    // 库内真相：批准时已建成员行并回填工作邮箱（开户结果）；邀请保持 approved——
    // 状态机口径：invites.consumed 只在「工作台首登 JIT 建档」时翻转（consumeApprovedInviteByEmail），
    // 激活只设邮箱密码（activate.ts 顶部注释：激活不建用户档案）。
    const member = db.first<{ email: string | null }>(
      'SELECT email FROM users WHERE email = ?',
      'wangxm@example.com',
    );
    expect(member).not.toBeNull();
    expect(db.first('SELECT status FROM invites WHERE token_hash = ?', tokenHash)).toEqual({
      status: 'approved',
    });
  });
});
