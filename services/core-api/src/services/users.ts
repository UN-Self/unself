// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 用户域（users 表）：JIT 建档、展示名推导、角色提升。
 * 只查 users 表，不跨域。
 */

/** 从 id_token claims 取展示名。 */
export function pickDisplayName(claims: Record<string, unknown>): string {
  for (const key of ['name', 'preferred_username', 'email']) {
    const v = claims[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '用户';
}

/** JIT 建档：issuer+sub 唯一；存在则复用（更新展示名），否则插入。 */
export async function upsertUser(
  db: D1Database,
  identity: { issuer: string; sub: string; name: string },
): Promise<string> {
  const existing = await db
    .prepare('SELECT id FROM users WHERE issuer = ? AND sub = ?')
    .bind(identity.issuer, identity.sub)
    .first<{ id: string }>();
  if (existing) {
    await db
      .prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .bind(identity.name, existing.id)
      .run();
    return existing.id;
  }
  const id = `u_${crypto.randomUUID().replace(/-/g, '')}`;
  await db
    .prepare('INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)')
    .bind(id, identity.issuer, identity.sub, identity.name, 'user')
    .run();
  return id;
}

/** 把用户提升为管理员（首个管理员诞生，§5.2）。 */
export async function promoteToAdmin(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare('UPDATE users SET role = ? WHERE id = ?')
    .bind('admin', userId)
    .run();
}

/** 取用户角色（/api/me 用）；行不存在时回 'user'（会话存在但档案被删的兜底）。 */
export async function getUserRole(db: D1Database, userId: string): Promise<string> {
  const row = await db
    .prepare('SELECT role FROM users WHERE id = ?')
    .bind(userId)
    .first<{ role: string }>();
  return row?.role ?? 'user';
}
