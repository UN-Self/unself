// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { createSessionToken } from '../src/session';
import { createCoreDb } from './test-factory';

/**
 * #19 触发点接线集成（主会话归属）：模块启停 TODO(#19) 占位处 → module_toggled 广播。
 * 行为口径：全员 active 成员各落一条站内通知（含操作者本人），disabled 不收；
 * payload 带 moduleId/enabled；mail 段未装配不报错（module_toggled 渠道位本就只站内）。
 */
async function envFor() {
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
  db.run(
    'INSERT INTO users (id, issuer, sub, display_name, role, status) VALUES (?, ?, ?, ?, ?, ?)',
    'u_off',
    'https://idp.example.com',
    'off-sub',
    '停用成员',
    'user',
    'disabled',
  );
  db.run(
    "INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES ('hello', 1, '1.0.0', '{}')",
  );
  const adminToken = await createSessionToken(
    { uid: 'u_admin', iss: 'https://idp.example.com', sub: 'admin-sub', name: '管理' },
    pair.privateKeyPem,
  );
  return {
    env: { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem },
    db,
    adminCookie: `unself_session=${adminToken}`,
  };
}

describe('模块启停 → module_toggled 广播（#19 接线）', () => {
  it('翻转启停给每个 active 成员落站内通知，disabled 不收', async () => {
    const app = createApp();
    const { env, db, adminCookie } = await envFor();

    const res = await app.request(
      'https://team.example.com/api/admin/modules/hello/toggle',
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const rows = db.query<{ user_id: string; type: string; payload: string; is_read: number }>(
      'SELECT user_id, type, payload, is_read FROM notifications ORDER BY user_id',
    );
    expect(rows.map((row) => row.user_id)).toEqual(['u_admin', 'u_member']);
    for (const row of rows) {
      expect(row.type).toBe('module_toggled');
      expect(JSON.parse(row.payload)).toEqual({ moduleId: 'hello', enabled: false });
      expect(row.is_read).toBe(0);
    }
  });
});
