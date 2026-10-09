// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 用户域（users 表）：JIT 建档、展示名推导、角色提升。
 * 只查 users 表，不跨域。
 */

/** 从 claims 取邮箱（保留原大小写；空值/非字符串 → undefined）。 */
export function pickEmail(claims: Record<string, unknown>): string | undefined {
  const v = claims.email;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** 从 claims 取名字（name/preferred_username）；email 不算名字（#49：名字缺失即走 userinfo 兜底）。 */
export function pickNameOrNull(claims: Record<string, unknown>): string | null {
  for (const key of ['name', 'preferred_username']) {
    const v = claims[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** 从 claims 取展示名：名字优先，缺则回退 email，最后 '用户'。 */
export function pickDisplayName(claims: Record<string, unknown>): string {
  return pickNameOrNull(claims) ?? pickEmail(claims) ?? '用户';
}

/**
 * JIT 建档：issuer+sub 唯一；存在则复用（仅空昵称回填，更新邮箱），否则插入。
 * created 供首登消费已批准邀请判定（#49：只在建档时消费，不重复消费）。
 */
export async function upsertUser(
  db: D1Database,
  identity: { issuer: string; sub: string; name: string; email?: string },
): Promise<{ id: string; created: boolean }> {
  // #190 B9 存储归一：email 落库统一小写（联系方式比较/去重都按小写口径）；展示仍用 users.display_name。
  const email = identity.email === undefined ? undefined : identity.email.toLowerCase();
  const existing = await db
    .prepare('SELECT id FROM users WHERE issuer = ? AND sub = ?')
    .bind(identity.issuer, identity.sub)
    .first<{ id: string }>();
  if (existing) {
    await db
      .prepare("UPDATE users SET display_name = CASE WHEN display_name IS NULL OR trim(display_name) = '' THEN ? ELSE display_name END, profile_revision = profile_revision + CASE WHEN display_name IS NULL OR trim(display_name) = '' THEN 1 ELSE 0 END, email = COALESCE(?, email) WHERE id = ?")
      .bind(identity.name, email ?? null, existing.id)
      .run();
    return { id: existing.id, created: false };
  }
  const id = `u_${crypto.randomUUID().replace(/-/g, '')}`;
  await db
    .prepare('INSERT INTO users (id, issuer, sub, display_name, email, role) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, identity.issuer, identity.sub, identity.name, email ?? null, 'user')
    .run();
  return { id, created: true };
}

/** 公共展示名只从 Core 读取；会话 Cookie 的 name 可能早于用户改名。 */
export async function getDisplayName(db: D1Database, userId: string): Promise<string | null> {
  return (await getProfileIdentity(db, userId))?.name ?? null;
}

export async function getProfileIdentity(db: D1Database, userId: string): Promise<{ name: string; revision: number; avatarKey: string | null } | null> {
  const row = await db.prepare('SELECT display_name, profile_revision, avatar_key FROM users WHERE id = ? AND status = ?')
    .bind(userId, 'active').first<{ display_name: string | null; profile_revision: number; avatar_key: string | null }>();
  return row ? { name: row.display_name ?? '', revision: row.profile_revision, avatarKey: row.avatar_key } : null;
}

/** 当前用户修改自己的昵称。 */
export async function updateDisplayName(db: D1Database, userId: string, name: string): Promise<boolean> {
  const result = await db.prepare('UPDATE users SET display_name = ?, profile_revision = profile_revision + 1 WHERE id = ? AND status = ?')
    .bind(name, userId, 'active').run();
  return (result.meta.changes ?? 0) > 0;
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
