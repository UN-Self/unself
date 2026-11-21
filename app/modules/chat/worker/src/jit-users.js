// SPDX-License-Identifier: AGPL-3.0-only
// #217 新增（unself 集成层，非上游件）：core 身份 JIT 建档——首见 token sub → users 表行 + issuer+sub 映射落库。
// users.username UNIQUE 是建档幂等第一锚点（core 身份走 'core:' 命名空间，与上游本地注册用户名天然隔离）；
// core_identities 是决策 #12「issuer+sub → 内部数字 id 唯一映射」的显式落库（schema-baseline.sql #217 增补）。

import { userAvatarUrl } from './profile-avatar.js';

/** core 身份在 chat 侧的确定性用户名（UNIQUE 冲突即幂等锚点）。 */
export function coreUsername(claims) {
  return `core:${claims.sub}`;
}

/**
 * 确保 core 身份已有内部建档，返回 {ok:true, user}（users 行）或 {ok:false, status, message}。
 * - 首见 sub：INSERT OR IGNORE 建档（display_name 回填 claims.name）+ core_identities 映射行；
 *   general 频道入席由 schema 的 add_new_user_to_general 触发器兜底，此处不重复写。
 * - display_name 只在为空时回填 claims.name（不在每次请求 UPDATE，减少写放大）。
 * - 登录名/邮箱/身份来源（#透传）同 display_name 口径：新建档写入，存量空值回填，不覆盖已有值。
 * - 停用复查：行被删/停用（is_disabled / disabled_until / deleted_at）→ 401（HTTP 停用语义）。
 */
export async function jitEnsureUser(db, claims) {
  const username = coreUsername(claims);
  const displayName = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null;
  // #透传：登录名/工作邮箱/身份来源（有才带）。身份来源只信签发侧签名过的 claims.identity_source
  // （核心 users.issuer 映射）——「claims.username 有无」不是证据：旧签发侧的内置账号 token 同样没有
  // username，按它推断会把内置账号永久误标成 'oidc'。claim 缺省（旧签发侧）→ null = 来源未知。
  const loginName = typeof claims.username === 'string' && claims.username ? claims.username : null;
  const workEmail = typeof claims.email === 'string' && claims.email ? claims.email : null;
  const identitySource = claims.identity_source === 'builtin' || claims.identity_source === 'oidc'
    ? claims.identity_source
    : null;

  await db.prepare(
    `INSERT OR IGNORE INTO users (username, display_name, password_hash, password_salt, core_login_name, core_email, core_identity_source)
     VALUES (?, coalesce(?, 'member-' || ?), '', '', ?, ?, ?)`
  )
    .bind(username, displayName, claims.sub, loginName, workEmail, identitySource)
    .run();

  await db.prepare(
    `INSERT OR IGNORE INTO core_identities (issuer, sub, user_id)
     SELECT ?, ?, id FROM users WHERE username = ?`
  )
    .bind(claims.iss, claims.sub, username)
    .run();

  const found = await db
    .prepare(
      `SELECT id, username, display_name, core_profile_revision, core_avatar_url, avatar_key, is_disabled, disabled_until, deleted_at, core_login_name, core_email, core_identity_source
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

  // Core 的单调修订号保护展示投影：旧 token 与续期乱序都不能回退昵称。
  const revision = claims.profile_revision;
  if (displayName && Number.isSafeInteger(revision) && revision >= 0 && revision > Number(user.core_profile_revision)) {
    const updated = await db.prepare(
      'UPDATE users SET display_name = ?, core_avatar_url = COALESCE(?, core_avatar_url), core_profile_revision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND core_profile_revision < ?'
    ).bind(displayName, typeof claims.avatar_url === 'string' ? claims.avatar_url : null, revision, user.id, revision).run();
    if (updated.meta.changes) {
      user.display_name = displayName;
      if (typeof claims.avatar_url === 'string') user.core_avatar_url = claims.avatar_url;
      user.core_profile_revision = revision;
    } else {
      // Another request may have committed a newer Core profile after the initial read.
      // Re-read so this request never returns the stale value it observed before the race.
      const current = await db.prepare(
        'SELECT display_name, core_profile_revision, core_avatar_url FROM users WHERE id = ?'
      ).bind(user.id).first();
      if (current) {
        user.display_name = current.display_name;
        user.core_avatar_url = current.core_avatar_url;
        user.core_profile_revision = current.core_profile_revision;
      }
    }
  }

  // #透传：登录名/工作邮箱/身份来源只在新建档写入；存量行为空时按 claims 回填（有才带、空不覆盖，防写放大）。
  // 身份来源必须回填——它是资料卡区分「OIDC 账号」与「来源未知」的唯一依据（见 0007 迁移）。
  // 自愈：早期版本按「claims.username 有无」推断来源，会把内置账号误标成 'oidc'；
  // 权威 claim 说 'builtin' 而库里的值是 'oidc' 时改写回来（反向不可能：同一 sub 的来源不会从 builtin 变 oidc）。
  const needsIdentityHeal = identitySource === 'builtin' && user.core_identity_source === 'oidc';
  // 来源未知（identitySource 为 null 且库值也是 NULL）时没有可写内容，必须跳过——
  // 否则 UPDATE 对 NULL 是恒等操作却每次请求都执行（写放大 + updated_at 抖动），且永不收敛。
  const needsIdentityBackfill = identitySource != null && user.core_identity_source == null;
  if ((loginName && user.core_login_name == null) || (workEmail && user.core_email == null) || needsIdentityBackfill || needsIdentityHeal) {
    await db.prepare(
      `UPDATE users SET core_login_name = COALESCE(core_login_name, ?), core_email = COALESCE(core_email, ?),
         core_identity_source = CASE WHEN ? = 'builtin' THEN 'builtin' ELSE COALESCE(core_identity_source, ?) END,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(loginName, workEmail, identitySource, identitySource, user.id).run();
    if (loginName) user.core_login_name = loginName;
    if (workEmail) user.core_email = workEmail;
    if (needsIdentityHeal || !user.core_identity_source) user.core_identity_source = identitySource;
  }

  return {
    ok: true,
    user: {
      id: Number(user.id),
      username: user.username,
      displayName: String(user.display_name || ''),
      avatarUrl: userAvatarUrl(user.core_avatar_url, user.avatar_key)
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
      `SELECT u.id, u.username, u.display_name, u.core_avatar_url, u.avatar_key, u.is_disabled, u.disabled_until, u.deleted_at
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
      displayName: String(user.display_name || ''),
      avatarUrl: userAvatarUrl(user.core_avatar_url, user.avatar_key)
    }
  };
}
