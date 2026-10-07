// SPDX-License-Identifier: AGPL-3.0-only
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyMigrations, createD1Adapter } from '../../../workbench/test/test-factory.ts';
import { jitEnsureUser } from '../worker/src/jit-users.js';

describe('Chat 使用 Core 昵称展示投影', () => {
  it('新修订生效，旧 token 和无修订号 token 不回退资料', async () => {
    const sqlite = new DatabaseSync(':memory:');
    applyMigrations(sqlite, fileURLToPath(new URL('../migrations/chat/', import.meta.url)));
    const db = createD1Adapter(sqlite);
    const base = { iss: 'unself-core', sub: 'u_1' };
    const initial = await jitEnsureUser(db, { ...base, name: '初始', profile_revision: 0 });
    expect(initial.ok).toBe(true);
    await jitEnsureUser(db, { ...base, name: '新昵称', profile_revision: 1 });
    await jitEnsureUser(db, { ...base, name: '过期昵称', profile_revision: 0 });
    await jitEnsureUser(db, { ...base, name: '无修订号旧 token' });
    const profile = sqlite.prepare('SELECT display_name, core_profile_revision FROM users WHERE username = ?')
      .get('core:u_1') as { display_name: string; core_profile_revision: number };
    expect(profile.display_name).toBe('新昵称');
    expect(profile.core_profile_revision).toBe(1);
    sqlite.close();
  });

});
