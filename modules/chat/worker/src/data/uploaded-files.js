// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/uploaded-files.js（GPL-3.0-only，裁剪版）
export function isR2ObjectUnavailableError(error) {
	const message = String(error?.message || error);
	return (
		message.includes("r2_object_pending_delete") ||
		message.includes("r2_local_object_unavailable")
	);
}

export async function recordUploadedFile(
	db,
	{ key, ownerUserId, filename, contentType, size, clientUploadId = null },
) {
	await db
		.prepare(
			`INSERT INTO uploaded_files (
				   object_key, owner_user_id, filename, content_type, size, client_upload_id, created_at
				 ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
				 ON CONFLICT(object_key) DO UPDATE SET
				   owner_user_id = excluded.owner_user_id,
				   filename = excluded.filename,
				   content_type = excluded.content_type,
				   size = excluded.size,
				   client_upload_id = excluded.client_upload_id`,
		)
		.bind(
			String(key),
			Number(ownerUserId),
			String(filename || ""),
			String(contentType || ""),
				Number(size || 0),
				clientUploadId ? String(clientUploadId) : null,
			)
		.run();
}

function mapUploadedFile(row) {
	return row
		? {
				key: row.object_key,
				name: row.filename,
				type: row.content_type,
				size: Number(row.size || 0),
				url: `/files/${encodeURIComponent(row.object_key)}`,
			}
		: null;
}

export async function getUploadedFileByClientId(db, userId, clientUploadId) {
	const { results } = await db
		.prepare(
			`SELECT object_key, filename, content_type, size
			 FROM uploaded_files
			 WHERE owner_user_id = ? AND client_upload_id = ?
			 LIMIT 1`,
		)
		.bind(Number(userId), String(clientUploadId))
		.all();
	return mapUploadedFile(results[0]);
}

export async function getUploadedFileMetadata(db, key) {
	const { results } = await db
		.prepare(
			`SELECT filename, content_type, size
			 FROM uploaded_files WHERE object_key = ? LIMIT 1`,
		)
		.bind(String(key))
		.all();
	const row = results[0];
	return row
		? {
				filename: row.filename,
				contentType: row.content_type,
				size: Number(row.size || 0),
			}
		: null;
}

export async function getOwnedUploadedFileMetadata(db, key, userId) {
	const { results } = await db
		.prepare(
			`SELECT filename, content_type, size
			 FROM uploaded_files
			 WHERE object_key = ? AND owner_user_id = ?
			   AND NOT EXISTS (
			     SELECT 1 FROM pending_r2_delete
			     WHERE pending_r2_delete.object_key = uploaded_files.object_key
			   )
			 LIMIT 1`,
		)
		.bind(String(key), Number(userId))
		.all();
	const row = results[0];
	return row
		? {
				filename: row.filename,
				contentType: row.content_type,
				size: Number(row.size || 0),
			}
		: null;
}

export async function fileBelongsToUser(db, key, userId) {
	const { results } = await db
		.prepare(
			`SELECT 1 AS found FROM uploaded_files
			 WHERE object_key = ? AND owner_user_id = ?
			   AND NOT EXISTS (
			     SELECT 1 FROM pending_r2_delete
			     WHERE pending_r2_delete.object_key = uploaded_files.object_key
			   )
			 LIMIT 1`,
		)
		.bind(String(key), Number(userId))
		.all();
	return Boolean(results[0]);
}

export async function canAccessFile(db, key, userId = null) {
	const cleanKey = String(key || "");
	if (!cleanKey) return false;

	// 头像本来就是公开资料，保持无会话访问，避免登录页和成员列表出现破图。
	const publicRefs = await db
		.prepare(
			`SELECT 1 AS found
			 WHERE NOT EXISTS (SELECT 1 FROM pending_r2_delete WHERE object_key = ?)
			   AND (
			     EXISTS (SELECT 1 FROM users WHERE avatar_key = ? AND deleted_at IS NULL)
			     OR EXISTS (SELECT 1 FROM channels WHERE avatar_key = ? AND deleted_at IS NULL)
			   )`,
		)
		.bind(cleanKey, cleanKey, cleanKey)
		.all();
	if (publicRefs.results[0]) return true;
	if (!Number.isFinite(Number(userId))) return false;

	// 发送前允许上传者预览；发送后则按消息所在公开群组或成员关系授权。
	const { results } = await db
		.prepare(
			`SELECT 1 AS found
			 WHERE NOT EXISTS (SELECT 1 FROM pending_r2_delete WHERE object_key = ?)
			   AND (EXISTS (
			   SELECT 1 FROM uploaded_files uf
			   WHERE uf.object_key = ? AND uf.owner_user_id = ?
			 ) OR EXISTS (
			   SELECT 1 FROM messages m
			   JOIN channels c ON c.id = m.channel_id
			   WHERE m.attachment_key = ?
			     AND m.deleted_at IS NULL AND c.deleted_at IS NULL
			     AND (c.kind = 'public' OR EXISTS (
			       SELECT 1 FROM channel_members cm
			       WHERE cm.channel_id = c.id AND cm.user_id = ?
			     ))
			 ))`,
		)
		.bind(cleanKey, cleanKey, Number(userId), cleanKey, Number(userId))
		.all();
	return Boolean(results[0]);
}
