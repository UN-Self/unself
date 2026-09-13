// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Bindings, CoreApiDependencies } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { requireAdmin } from '../src/middleware/admin';
import { registerMailTestRoutes } from '../src/routes/mail-test';
import { createSessionToken } from '../src/session';
import { createCoreDb, type CoreTestDb } from './test-factory';

const URL = 'https://team.example.com/api/admin/mail/test';

async function setup(): Promise<{ env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string }; db: CoreTestDb; cookie: string }> {
  const pair = await generateInstanceKeyPair();
  const db = createCoreDb();
  db.run("INSERT INTO users (id, issuer, sub, display_name, role) VALUES ('admin', 'i', 's', '管理员', 'admin')");
  const token = await createSessionToken({ uid: 'admin', iss: 'i', sub: 's', name: '管理员' }, pair.privateKeyPem);
  return { env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem }, db, cookie: `unself_session=${token}` };
}

function app(deps?: CoreApiDependencies): Hono<{ Bindings: Bindings }> {
  const instance = new Hono<{ Bindings: Bindings }>();
  instance.use('/api/admin/*', requireAdmin());
  registerMailTestRoutes(instance, deps);
  return instance;
}

function seedMail(db: CoreTestDb): void {
  db.run('INSERT INTO instance_config (key, value) VALUES (?, ?)', 'mail', JSON.stringify({ baseUrl: 'https://mail', apiKey: 'key', domain: 'example.com', host: 'smtp', port: 465, username: 'user', password: 'pass', from: 'no-reply@example.com' }));
  db.run("INSERT INTO invites (token_hash, status, personal_email, email_prefix, display_name, expires_at) VALUES ('i', 'pending', 'a@b.test', 'a', 'A', datetime('now', '+1 day'))");
  db.run("INSERT INTO notifications (id, type, payload) VALUES ('n', 'invite_result', '{}')");
  db.run("INSERT INTO builtin_credentials (user_id, username, password_hash) VALUES ('admin', 'admin', 'hash')");
}

function counts(db: CoreTestDb): Record<string, number> {
  return Object.fromEntries(['users', 'invites', 'notifications', 'builtin_credentials', 'audit_log'].map((table) => [table, db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n]));
}

describe('POST /api/admin/mail/test', () => {
  it('双轴成功且零业务写入，仅新增一条 mail_tested 审计', async () => {
    const { env, db, cookie } = await setup();
    seedMail(db);
    const before = counts(db);
    const provisioner = { testConnection: vi.fn(async () => {}) };
    const sender = { testConnection: vi.fn(async () => {}) };
    const res = await app({ createMailProvisioner: () => provisioner as never, createMailSender: () => sender as never }).request(URL, { method: 'POST', headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provisioner: { ok: true, detail: 'Provisioner 连接测试成功' }, sender: { ok: true, detail: 'SMTP 连接、认证与退出测试成功（未投递邮件）' } });
    const after = counts(db);
    for (const table of ['users', 'invites', 'notifications', 'builtin_credentials']) expect(after[table]).toBe(before[table]);
    expect(after.audit_log).toBe(before.audit_log! + 1);
    expect(db.first<{ action: string }>('SELECT action FROM audit_log')).toEqual({ action: 'mail_tested' });
    expect(provisioner.testConnection).toHaveBeenCalledOnce();
    expect(sender.testConnection).toHaveBeenCalledOnce();
  });

  it('provisioner 401 与 sender auth 失败返回指路文案', async () => {
    const { env, db, cookie } = await setup();
    seedMail(db);
    const res = await app({ createMailProvisioner: () => ({ testConnection: async () => { throw new Error('HTTP 401 Unauthorized') } } as never), createMailSender: () => ({ testConnection: async () => { throw new Error('auth failed') } } as never) }).request(URL, { method: 'POST', headers: { cookie } }, env);
    const body = await res.json() as { provisioner: { detail: string }; sender: { detail: string } };
    expect(body.provisioner.detail).toContain('API Key');
    expect(body.sender.detail).toContain('用户名密码');
  });

  it('未配置 mail 段时双轴均引导先保存配置', async () => {
    const { env, cookie } = await setup();
    const res = await app().request(URL, { method: 'POST', headers: { cookie } }, env);
    const body = await res.json() as { provisioner: { detail: string }; sender: { detail: string } };
    expect(body.provisioner.detail).toContain('请先保存');
    expect(body.sender.detail).toContain('请先保存');
  });

  it('无 admin cookie 时被真实闸门拒绝为 401', async () => {
    const { env } = await setup();
    expect((await app().request(URL, { method: 'POST' }, env)).status).toBe(401);
  });
});
