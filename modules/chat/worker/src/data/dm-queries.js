// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/dm-queries.js（GPL-3.0-only，裁剪版）
import { publicFileUrl } from "../utils.js";

function mapUserDm(row) {
	return {
		id: Number(row.id),
		kind: "dm",
		name: row.dm_key,
		lastMessageAt: row.last_message_at || null,
		unreadCount: Number(row.unread_count || 0),
		mentionUnreadCount: Number(row.attention_unread_count || 0),
		otherUser: {
			id: Number(row.other_user_id),
			username: row.other_username,
			displayName: row.other_display_name,
			avatarUrl: row.other_avatar_key ? publicFileUrl(row.other_avatar_key) : "",
		},
		isBlockedByMe: Boolean(row.blocked_by_me),
	};
}

function mapAdminDm(row) {
	return {
		id: Number(row.id),
		name: row.dm_key,
		participants: row.participants,
		createdAt: row.created_at,
		messageCount: Number(row.message_count),
	};
}

export async function listUserDms(db, userId) {
	const normalizedUserId = Number(userId);
	const { results } = await db
		.prepare(
			`SELECT
			   c.id, c.dm_key,
			   other.id AS other_user_id,
			   other.username AS other_username,
			   other.display_name AS other_display_name,
			   other.avatar_key AS other_avatar_key,
			   EXISTS(SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = ? AND ub.blocked_id = other.id) AS blocked_by_me,
			   (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL) AS last_message_at,
				   (SELECT COUNT(*) FROM messages m
				    WHERE m.channel_id = c.id AND m.deleted_at IS NULL
				      AND (m.sender_id IS NULL OR m.sender_id != ?)
					      AND m.id > COALESCE((SELECT mr.last_read_message_id FROM message_reads mr WHERE mr.channel_id = c.id AND mr.user_id = ?), 0)) AS unread_count,
					   (SELECT COUNT(*) FROM messages m
					    WHERE m.channel_id = c.id AND m.deleted_at IS NULL
					      AND (m.sender_id IS NULL OR m.sender_id != ?)
					      AND m.id > COALESCE((SELECT mr.last_read_message_id FROM message_reads mr WHERE mr.channel_id = c.id AND mr.user_id = ?), 0)
					      AND m.reply_to_sender_id = ?) AS attention_unread_count
			 FROM channels c
			 JOIN channel_members me ON me.channel_id = c.id AND me.user_id = ?
			 JOIN channel_members peer ON peer.channel_id = c.id AND peer.user_id != ?
			 JOIN users other ON other.id = peer.user_id
			 WHERE c.kind = 'dm' AND c.deleted_at IS NULL AND other.deleted_at IS NULL
			 ORDER BY last_message_at DESC NULLS LAST, c.id DESC`,
			)
				.bind(
					normalizedUserId,
					normalizedUserId,
					normalizedUserId,
					normalizedUserId,
					normalizedUserId,
					normalizedUserId,
					normalizedUserId,
					normalizedUserId,
				)
		.all();
	return results.map(mapUserDm);
}

export async function listAdminDms(db) {
	const { results } = await db
		.prepare(
			`SELECT
			   c.id, c.dm_key, c.created_at,
			   (SELECT GROUP_CONCAT(display_name, ' / ')
			    FROM (SELECT u.display_name AS display_name
			          FROM channel_members cm JOIN users u ON u.id = cm.user_id
			          WHERE cm.channel_id = c.id AND u.deleted_at IS NULL
			          ORDER BY u.id ASC)) AS participants,
			   (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL) AS message_count
			 FROM channels c
			 WHERE c.kind = 'dm' AND c.deleted_at IS NULL
			 ORDER BY c.created_at DESC`,
		)
		.all();
	return results.map(mapAdminDm);
}
