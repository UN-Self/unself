// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { issueInviteActivation } from '../src/services/invite-activations';
import { hashOneTimeToken } from '../src/one-time-token';
import { generateInstanceKeyPair } from '../src/keys';
import { createSessionToken } from '../src/session';
import { createCoreDb } from './test-factory';

describe('重发激活邮件', () => {
  it('作废旧令牌、签发新令牌、发送新链接并审计', async () => {
    const db = createCoreDb();
    const pair = await generateInstanceKeyPair();
    db.run("INSERT INTO users (id, issuer, sub, display_name, personal_email, role) VALUES ('u1','builtin','u1','成员','p@example.com','admin')");
    db.run("INSERT INTO invites (token_hash,status,personal_email,email_prefix,display_name,expires_at) VALUES ('i1','approved','p@example.com','m','成员','2099-01-01 00:00:00')");
    const oldToken = await issueInviteActivation(db.d1, 'i1', 'm@example.com');
    const sent: string[] = [];
    db.run("INSERT INTO instance_config (key,value) VALUES ('mail','{}')");
    const admin = await createSessionToken({ uid: 'u1', iss: 'x', sub: 'u1', name: '管理员' }, pair.privateKeyPem);
    const app = createApp({ createMailSender: () => ({ send: async ({ text }: { text: string }) => sent.push(text) }) as any });
    const res = await app.request('https://x/api/admin/members/u1/resend-activation', { method: 'POST', headers: { cookie: `unself_session=${admin}` } }, { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem });
    expect(res.status).toBe(200);
    expect(db.first("SELECT used_at FROM invite_activations WHERE token_hash = ?", await hashOneTimeToken(oldToken))?.used_at).not.toBeNull();
    expect(sent).toHaveLength(1);
    const old = await app.request(`https://x/api/activate/${oldToken}`, {}, { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem });
    expect(old.status).toBe(404);
    expect(db.query("SELECT action FROM audit_log WHERE action='activation_resent'")).toHaveLength(1);
  });
});
