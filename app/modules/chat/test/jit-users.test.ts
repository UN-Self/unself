// SPDX-License-Identifier: AGPL-3.0-only
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyMigrations, createD1Adapter } from '../../../workbench/test/test-factory.ts';
import { listContacts } from '../worker/src/data/users.js';
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

  it('Core 头像随资料版本投影，旧 token 不覆盖，移除后不恢复旧 Chat 头像', async () => {
    const sqlite = new DatabaseSync(':memory:');
    applyMigrations(sqlite, fileURLToPath(new URL('../migrations/chat/', import.meta.url)));
    const db = createD1Adapter(sqlite);
    const base = { iss: 'unself-core', sub: 'u_avatar', name: '成员' };
    const url = 'https://team.example/api/avatars/new-avatar';
    await jitEnsureUser(db, { ...base, profile_revision: 1, avatar_url: url });
    sqlite.prepare("INSERT INTO uploaded_files (object_key, owner_user_id, filename, content_type, size) SELECT 'legacy.png', id, 'legacy.png', 'image/png', 1 FROM users WHERE username = 'core:u_avatar'").run();
    sqlite.prepare('UPDATE users SET avatar_key = ? WHERE username = ?').run('legacy.png', 'core:u_avatar');
    const old = await jitEnsureUser(db, { ...base, profile_revision: 0, avatar_url: 'https://team.example/old.png' });
    expect(old.user?.avatarUrl).toBe(url);
    expect((await listContacts(db))[0].avatarUrl).toBe(url);
    await jitEnsureUser(db, { ...base, profile_revision: 2, avatar_url: '' });
    await jitEnsureUser(db, { ...base, profile_revision: 1, avatar_url: url });
    expect((await listContacts(db))[0].avatarUrl).toBe('');
    sqlite.close();
  });

  it('条件更新落空时重读，返回并发请求已经提交的昵称', async () => {
    const sqlite = new DatabaseSync(':memory:');
    applyMigrations(sqlite, fileURLToPath(new URL('../migrations/chat/', import.meta.url)));
    const real = createD1Adapter(sqlite);
    let profileRead = false;
    const db = {
      prepare(sql: string) {
        if (sql.startsWith('SELECT id, username, display_name')) {
          return {
            bind(...values: unknown[]) {
              const statement = real.prepare(sql).bind(...values);
              return {
                all: async () => {
                  const result = await statement.all();
                  if (!profileRead && result.results[0]) {
                    profileRead = true;
                    result.results[0].display_name = '旧昵称';
                    result.results[0].core_profile_revision = 0;
                  }
                  return result;
                },
              };
            },
          };
        }
        if (sql.startsWith('UPDATE users SET display_name')) {
          return {
            bind() {
              return {
                run: async () => {
                  sqlite.prepare('UPDATE users SET display_name = ?, core_profile_revision = ? WHERE username = ?')
                    .run('并发新昵称', 2, 'core:u_race');
                  return { meta: { changes: 0 } };
                },
              };
            },
          };
        }
        return real.prepare(sql);
      },
    };

    const result = await jitEnsureUser(db, { iss: 'unself-core', sub: 'u_race', name: '请求昵称', profile_revision: 1 });
    expect(result).toMatchObject({ ok: true, user: { displayName: '并发新昵称' } });
    sqlite.close();
  });

});
