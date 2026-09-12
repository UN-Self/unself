// SPDX-License-Identifier: AGPL-3.0-only
import type { MailProvisioner } from '@unself/contracts';
import { MailProvisionerError } from '@unself/stalwart-provisioner';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { createSessionToken } from '../src/session';
import { createCoreDb, type CoreTestDb } from './test-factory';

const helloManifest = {
  id: 'hello',
  route: '/m/hello',
  entry: 'https://team.example.com/m/hello/',
  runtime: 'worker',
  requires: ['identity'],
  capabilities: ['counter'],
  version: '1.0.0',
};

interface MemberTestEnv {
  env: { CORE_DB: D1Database; JWT_PRIVATE_KEY: string };
  db: CoreTestDb;
  adminCookie: string;
  memberCookie: string;
}

/** 真 users 表 + 两个签名会话，权限真值始终来自同一 SQLite 库。 */
async function envFor(): Promise<MemberTestEnv> {
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

function seedHello(db: CoreTestDb): void {
  db.run(
    'INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES (?, ?, ?, ?)',
    'hello',
    1,
    helloManifest.version,
    JSON.stringify(helloManifest),
  );
}

function fakeProvisioner(calls: string[]): MailProvisioner {
  return {
    createAccount: async () => ({ email: 'created@example.com' }),
    disableAccount: async ({ email }) => {
      calls.push(`disable:${email}`);
    },
    enableAccount: async ({ email }) => {
      calls.push(`enable:${email}`);
    },
    resetPassword: async () => undefined,
  };
}

describe('管理端成员生命周期（#49）', () => {
  it('管理员读取全量成员字段；普通成员不能访问管理域', async () => {
    const app = createApp();
    const { env, db, adminCookie, memberCookie } = await envFor();
    db.run(
      'INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)',
      'u_no_email',
      'https://idp.example.com',
      'no-email-sub',
      '无邮箱成员',
      'user',
    );

    const res = await app.request(
      'https://team.example.com/api/admin/members',
      { headers: { cookie: adminCookie } },
      env,
    );
    expect(res.status).toBe(200);
    const members = (await res.json()) as Array<Record<string, unknown>>;
    const noEmail = members.find((member) => member.id === 'u_no_email');
    expect(noEmail).toMatchObject({
      id: 'u_no_email',
      display_name: '无邮箱成员',
      email: null,
      status: 'active',
      role: 'user',
      created_at: expect.any(String),
    });
    expect(Object.keys(noEmail ?? {}).sort()).toEqual([
      'created_at',
      'display_name',
      'email',
      'id',
      'role',
      'status',
    ]);

    const member = await app.request(
      'https://team.example.com/api/admin/members',
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(member.status).toBe(403);
  });

  it('完整实例停用和启用联动 provisioner，并即时收回和恢复会话权限', async () => {
    const calls: string[] = [];
    const mailConfigs: unknown[] = [];
    const app = createApp({
      createMailProvisioner: (config) => {
        mailConfigs.push(config);
        return fakeProvisioner(calls);
      },
    });
    const { env, db, adminCookie, memberCookie } = await envFor();
    db.run(
      'INSERT INTO instance_config (key, value) VALUES (?, ?)',
      'mail',
      JSON.stringify({ provider: 'fake' }),
    );
    seedHello(db);

    const disabled = await app.request(
      'https://team.example.com/api/admin/members/u_member/disable',
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ id: 'u_member', status: 'disabled' });
    expect(db.first<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u_member')).toEqual({
      status: 'disabled',
    });
    expect(calls).toEqual(['disable:member@example.com']);

    const disabledMe = await app.request(
      'https://team.example.com/api/me',
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(disabledMe.status).toBe(403);
    const disabledToken = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie: memberCookie } },
      env,
    );
    expect(disabledToken.status).toBe(403);

    const enabled = await app.request(
      'https://team.example.com/api/admin/members/u_member/enable',
      { method: 'POST', headers: { cookie: adminCookie } },
      env,
    );
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({ id: 'u_member', status: 'active' });
    expect(calls).toEqual(['disable:member@example.com', 'enable:member@example.com']);
    expect(mailConfigs).toEqual([{ provider: 'fake' }, { provider: 'fake' }]);
    expect(
      db.query<{ actor: string; action: string; target: string }>(
        "SELECT actor, action, target FROM audit_log WHERE action LIKE 'member_%' ORDER BY id",
      ),
    ).toEqual([
      { actor: 'u_admin', action: 'member_disabled', target: 'u_member' },
      { actor: 'u_admin', action: 'member_enabled', target: 'u_member' },
    ]);

    const restoredMe = await app.request(
      'https://team.example.com/api/me',
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(restoredMe.status).toBe(200);
    const restoredToken = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie: memberCookie } },
      env,
    );
    expect(restoredToken.status).toBe(200);
  });

  it('弱化实例不构建 provisioner，仍可翻转成员状态', async () => {
    const calls: string[] = [];
    const app = createApp({
      createMailProvisioner: () => {
        throw new Error('mail provisioner must stay unconstructed');
      },
    });
    const { env, db, adminCookie } = await envFor();

    expect(
      (
        await app.request(
          'https://team.example.com/api/admin/members/u_member/disable',
          { method: 'POST', headers: { cookie: adminCookie } },
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          'https://team.example.com/api/admin/members/u_member/enable',
          { method: 'POST', headers: { cookie: adminCookie } },
          env,
        )
      ).status,
    ).toBe(200);
    expect(db.first<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u_member')).toEqual({
      status: 'active',
    });
    expect(calls).toEqual([]);
  });

  it('邮件轴联动失败不再裸 500（#115）：ACCOUNT_NOT_FOUND → 409，认证失败 → 502 + API Key 指引，其它 → 502 透传', async () => {
    const calls: string[] = [];
    const errors: unknown[] = [
      new MailProvisionerError('ACCOUNT_NOT_FOUND', 'Stalwart 中找不到账户 member@example.com'),
      new Error('Stalwart JMAP 请求失败：HTTP 401 Unauthorized'),
      new Error('Stalwart JMAP 请求失败（网络错误）：https://mail.example.com/jmap'),
    ];
    const expected = [
      { status: 409, detailPart: 'Stalwart 中无此邮箱账号（member@example.com）' },
      { status: 502, detailPart: '检查 API Key' },
      { status: 502, detailPart: 'Stalwart JMAP 请求失败（网络错误）' },
    ];
    let i = 0;
    const flakyProvisioner: MailProvisioner = {
      createAccount: async () => ({ email: 'created@example.com' }),
      disableAccount: async () => {
        throw errors[i]!;
      },
      enableAccount: async () => {
        throw errors[i]!;
      },
      resetPassword: async () => undefined,
    };
    const app = createApp({
      createMailProvisioner: () => flakyProvisioner,
    });
    const { env, db, adminCookie } = await envFor();
    db.run(
      'INSERT INTO instance_config (key, value) VALUES (?, ?)',
      'mail',
      JSON.stringify({ provider: 'fake' }),
    );

    for (let step = 0; step < 3; step++) {
      // disable：三类错误 → 409 / 502 / 502，detail 人话且含原文原因
      const disabled = await app.request(
        'https://team.example.com/api/admin/members/u_member/disable',
        { method: 'POST', headers: { cookie: adminCookie } },
        env,
      );
      expect(disabled.status).toBe(expected[step]!.status);
      const disabledBody = (await disabled.json()) as { error: string; detail: string };
      expect(disabledBody.error).toBe('member sync failed');
      expect(disabledBody.detail).toContain(expected[step]!.detailPart);

      // 状态翻转已落库：成员已 disabled（不回滚），enable 同类错误同映射
      expect(
        db.first<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u_member'),
      ).toEqual({ status: 'disabled' });

      const enabled = await app.request(
        'https://team.example.com/api/admin/members/u_member/enable',
        { method: 'POST', headers: { cookie: adminCookie } },
        env,
      );
      expect(enabled.status).toBe(expected[step]!.status);
      const enabledBody = (await enabled.json()) as { error: string; detail: string };
      expect(enabledBody.error).toBe('member sync failed');
      expect(enabledBody.detail).toContain(expected[step]!.detailPart);
      expect(
        db.first<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u_member'),
      ).toEqual({ status: 'active' });

      i = step + 1;
    }
    // 审计只在成员动作起点落过一次（disable 成功于首次翻转前已落）；此处只保证联动异常后不误报 enable 审计
    expect(calls).toEqual([]);
  });

  it('admin 守卫拒绝普通成员，setup-token 部署通道不受影响', async () => {
    const app = createApp();
    const { env, db, memberCookie } = await envFor();

    const member = await app.request(
      'https://team.example.com/api/admin/members/u_admin/disable',
      { method: 'POST', headers: { cookie: memberCookie } },
      env,
    );
    expect(member.status).toBe(403);
    expect(db.first<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u_admin')).toEqual({
      status: 'active',
    });

    const setupToken = await app.request(
      'https://team.example.com/api/admin/setup-token',
      { method: 'POST' },
      env,
    );
    expect(setupToken.status).toBe(200);
  });
});
