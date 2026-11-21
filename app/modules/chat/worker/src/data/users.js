// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/users.js（GPL-3.0-only，裁剪版）
import { userAvatarUrl } from "../profile-avatar.js";
import { activeUserSql, projectUserBan } from "../user-status.js";

/**
 * #透传：真实登录名投影（资料卡句柄行的唯一来源）。
 * 三态：string=内置账号登录名；null=明确是 OIDC 账号（前端显示占位）；undefined=不输出该字段。
 * 只有 core_identity_source='oidc' 才给 null——存量行未回填、mock/未升级 worker、SELECT 未带
 * 这些列时来源都是 undefined，一律省略字段（前端整行不渲染），避免把内置账号标成 OIDC。
 * `core:<sub>` 幂等锚点永不外露。
 */
export function projectLoginName(loginName, identitySource) {
	if (typeof loginName === 'string' && loginName) return loginName;
	if (identitySource === 'oidc') return null;
	return undefined;
}

/**
 * #透传出参：真实登录名/工作邮箱投影。
 * 只在 core 身份（username 以 `core:` 开头）上输出 loginName；email 有则带、无则省略（前端「无则隐藏」）。
 * 两个列都没 SELECT 时 row 值为 undefined → 两字段都不输出（同旧行为）。
 */
export function projectIdentity(row) {
	const projected = {};
	if (String(row.username || '').startsWith("core:")) {
		const loginName = projectLoginName(row.core_login_name, row.core_identity_source);
		if (loginName !== undefined) projected.loginName = loginName;
	}
	if (row.core_email) {
		projected.email = row.core_email;
	}
	return projected;
}

function mapUserSummary(row) {
	return {
		id: Number(row.id),
		username: row.username,
		displayName: row.display_name,
		avatarUrl: userAvatarUrl(row.core_avatar_url, row.avatar_key),
		...projectIdentity(row),
	};
}

export async function getUserProfile(db, userId) {
	const { results } = await db.prepare(
		`SELECT id, username, display_name, core_avatar_url, avatar_key, bio, core_login_name, core_email, core_identity_source
		 FROM users WHERE id = ? AND deleted_at IS NULL AND ${activeUserSql()} LIMIT 1`,
	).bind(userId).all();
	const row = results[0];
	return row ? { ...mapUserSummary(row), bio: row.bio } : null;
}

function mapAdminUser(row) {
	return {
		...mapUserSummary(row),
		...projectUserBan(row),
		createdAt: row.created_at,
	};
}

export async function getUserByUsername(db, username) {
	const { results } = await db
		.prepare(
			`SELECT *
			 FROM users
			 WHERE username = ?
			   AND deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(username)
		.all();
	return results[0] || null;
}

export async function isUserActiveById(db, userId) {
	const { results } = await db
		.prepare(
			`SELECT id
			 FROM users
			 WHERE id = ?
			   AND deleted_at IS NULL
				   AND ${activeUserSql()}
			 LIMIT 1`,
		)
		.bind(Number(userId))
		.all();
	return Boolean(results[0]);
}

export async function listActiveUsers(db, excludeUserId) {
	const { results } = await db
		.prepare(
			`SELECT id, username, display_name, core_avatar_url, avatar_key
			 FROM users
			 WHERE deleted_at IS NULL
				   AND ${activeUserSql()}
			   AND id != ?
			 ORDER BY display_name ASC`,
		)
		.bind(Number(excludeUserId))
		.all();
	return results.map(mapUserSummary);
}

export async function listContacts(db) {
	const { results } = await db
		.prepare(
			`SELECT id, username, display_name, core_avatar_url, avatar_key, core_login_name, core_email, core_identity_source
			 FROM users
			 WHERE deleted_at IS NULL
			   AND ${activeUserSql()}
			 ORDER BY display_name ASC, username ASC, id ASC`,
		)
		.all();
	return results.map(mapUserSummary);
}

export async function listAdminUsers(db) {
	const { results } = await db
		.prepare(
			`SELECT id, username, display_name, core_avatar_url, avatar_key, is_disabled, disabled_until, created_at
			 FROM users
			 WHERE deleted_at IS NULL
			 ORDER BY created_at DESC`,
		)
		.all();
	return results.map(mapAdminUser);
}

export async function listStorageOwners(db) {
	const { results } = await db
		.prepare(
			`SELECT id, username, display_name, deleted_at
			 FROM users
			 ORDER BY id ASC`,
		)
		.all();
	return results.map((row) => ({
		id: Number(row.id),
		username: row.username,
		displayName: row.display_name,
		isDeleted: Boolean(row.deleted_at),
	}));
}
