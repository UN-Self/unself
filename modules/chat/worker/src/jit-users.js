// SPDX-License-Identifier: AGPL-3.0-only
// #217 新增（unself 集成层，非上游件）：core 身份 JIT 建档——首见 token sub → users 表行 + issuer+sub 映射落库。
// users.username UNIQUE 是建档幂等第一锚点（core 身份走 'core:' 命名空间，与上游本地注册用户名天然隔离）；
// core_identities 是决策 #12「issuer+sub → 内部数字 id 唯一映射」的显式落库（schema-baseline.sql #217 增补）。

/** core 身份在 chat 侧的确定性用户名（UNIQUE 冲突即幂等锚点）。 */
export function coreUsername(claims) {
  return `core:${claims.sub}`;
}

/**
 * 确保 core 身份已有内部建档，返回 {ok:true, user}（users 行）或 {ok:false, status, message}。
 * - 首见 sub：INSERT OR IGNORE 建档（display_name 回填 claims.name）+ core_identities 映射行；
 *   general 频道入席由 schema 的 add_new_user_to_general 触发器兜底，此处不重复写。
 * - display_name 只在为空时回填 claims.name（不在每次请求 UPDATE，减少写放大）。
 * - 停用复查：行被删/停用（is_disabled / disabled_until / deleted_at）→ 401（HTTP 停用语义）。
 */
export async function jitEnsureUser(db, claims) {
  const username = coreUsername(claims);
  const displayName = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null;

  db.prepare(
    `INSERT OR IGNORE INTO users (username, display_name, password_hash, password_salt)
     VALUES (?, coalesce(?, 'member-' || ?), '', '')`
  )
    .bind(username, displayName, claims.sub)
    .run();

  db.prepare(
    `INSERT OR IGNORE INTO core_identities (issuer, sub, user_id)
     SELECT ?, ?, id FROM users WHERE username = ?`
  )
    .bind(claims.iss, claims.sub, username)
    .run();

  const found = await db
    .prepare(
      `SELECT id, username, display_name, is_disabled, disabled_until, deleted_at
       FROM users
       WHERE username = ?
       LIMIT 1`
    )
    .bind(username)
    .all();
  const user = found.results[0];
  if (!user) {
    // 理论并发窗口（建行后再查不到）：按未认证处理，不回显细节。
    return { ok: false, status: 401, message: '请先登录' };
  }

  // 停用/删档复查：token 仍有效但行已停用 → 拒（对齐上游 validateSession 的停用语义）。
  const disabledUntil = Date.parse(String(user.disabled_until || ''));
  const isDisabled = Boolean(Number(user.is_disabled)) || (Number.isFinite(disabledUntil) && disabledUntil > Date.now());
  if (user.deleted_at || isDisabled) {
    return { ok: false, status: 401, message: '账号已停用' };
  }

  // display_name 为空时用 claims.name 回填（一次性，不逐请求 UPDATE）。
  if (displayName && !String(user.display_name || '').trim()) {
    db.prepare('UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(displayName, user.id)
      .run();
    user.display_name = displayName;
  }

  return {
    ok: true,
    user: {
      id: Number(user.id),
      username: user.username,
      displayName: String(user.display_name || '')
    }
  };
}

/**
 * 内部 id 反查（WS /connect 的 ?token= 路径与续期换绑复用）：
 * 由 claims（issuer+sub）查 core_identities → users 行；无映射或已停用 → {ok:false,…}。
 */
export async function jitResolveUser(db, claims) {
  const found = await db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_disabled, u.disabled_until, u.deleted_at
       FROM core_identities ci
       JOIN users u ON u.id = ci.user_id
       WHERE ci.issuer = ? AND ci.sub = ?
       LIMIT 1`
    )
    .bind(claims.iss, claims.sub)
    .all();
  const user = found.results[0];
  if (!user) {
    return { ok: false, status: 401, message: '请先登录' };
  }

  const disabledUntil = Date.parse(String(user.disabled_until || ''));
  const isDisabled = Boolean(Number(user.is_disabled)) || (Number.isFinite(disabledUntil) && disabledUntil > Date.now());
  if (user.deleted_at || isDisabled) {
    return { ok: false, status: 401, message: '账号已停用' };
  }

  return {
    ok: true,
    user: {
      id: Number(user.id),
      username: user.username,
      displayName: String(user.display_name || '')
    }
  };
}
