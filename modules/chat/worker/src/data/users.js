// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/users.js（GPL-3.0-only，裁剪版）
import { publicFileUrl } from "../utils.js";
import { activeUserSql, projectUserBan } from "../user-status.js";

function mapUserSummary(row) {
	return {
		id: Number(row.id),
		username: row.username,
		displayName: row.display_name,
		avatarUrl: row.avatar_key ? publicFileUrl(row.avatar_key) : "",
	};
}

export async function getUserProfile(db, userId) {
	const { results } = await db.prepare(
		`SELECT id, username, display_name, avatar_key, bio
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
			`SELECT id, username, display_name, avatar_key
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
			`SELECT id, username, display_name, avatar_key
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
			`SELECT id, username, display_name, avatar_key, is_disabled, disabled_until, created_at
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
