// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/channels.js（GPL-3.0-only，裁剪版）
import { publicFileUrl } from "../utils.js";

function mapVisibleChannel(row) {
	return {
		id: Number(row.id),
		name: row.name,
		description: row.description,
		avatarKey: row.avatar_key || "",
		avatarUrl: row.avatar_key ? publicFileUrl(row.avatar_key) : "",
		kind: row.kind,
		isGeneral: Boolean(Number(row.is_general)),
		ownerDisplayName: row.owner_display_name || "",
		isMember: Boolean(Number(row.is_member)),
		myRole: row.my_role || "",
		canManage: Boolean(Number(row.can_manage)),
		memberCount: Number(row.member_count || 0),
		lastMessageAt: row.last_message_at || null,
		unreadCount: Number(row.unread_count || 0),
			mentionUnreadCount: Number(row.attention_unread_count || 0),
	};
}

function mapAdminChannel(row, includeAvatar) {
	const channel = {
		id: Number(row.id),
		name: row.name,
		description: row.description,
		kind: row.kind,
		isGeneral: Boolean(Number(row.is_general)),
		createdAt: row.created_at,
		ownerDisplayName: row.owner_display_name || "未知",
		memberCount: Number(row.member_count),
		messageCount: Number(row.message_count),
	};
	if (includeAvatar) {
		channel.avatarKey = row.avatar_key || "";
		channel.avatarUrl = row.avatar_key ? publicFileUrl(row.avatar_key) : "";
	}
	return channel;
}

export async function listVisibleChannels(db, userId) {
	const normalizedUserId = Number(userId);
	const { results } = await db
		.prepare(
				`SELECT
				   c.id, c.name, c.description, c.avatar_key, c.kind,
				   CASE WHEN c.name = 'general' THEN 1 ELSE 0 END AS is_general,
			   owner.display_name AS owner_display_name,
			   EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?) AS is_member,
			   COALESCE((SELECT cm.role FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ? LIMIT 1), '') AS my_role,
			   EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ? AND cm.role = 'owner') AS can_manage,
			   (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = c.id) AS member_count,
			   (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL) AS last_message_at,
				   CASE WHEN EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
				     THEN (SELECT COUNT(*) FROM messages m
				           WHERE m.channel_id = c.id AND m.deleted_at IS NULL
				             AND (m.sender_id IS NULL OR m.sender_id != ?)
			             AND m.id > COALESCE((SELECT mr.last_read_message_id FROM message_reads mr WHERE mr.channel_id = c.id AND mr.user_id = ?), 0))
				     ELSE 0 END AS unread_count,
					   CASE WHEN EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
					     THEN (SELECT COUNT(*) FROM messages m
					           WHERE m.channel_id = c.id AND m.deleted_at IS NULL
					             AND m.id > COALESCE((SELECT mr.last_read_message_id FROM message_reads mr WHERE mr.channel_id = c.id AND mr.user_id = ?), 0)
					             AND (m.sender_id IS NULL OR m.sender_id != ?)
					             AND (
					               EXISTS (
					                 SELECT 1 FROM json_each(COALESCE(m.mention_user_ids, '[]')) mention_ids
					                 WHERE CAST(mention_ids.value AS INTEGER) = ?
					               )
					               OR m.reply_to_sender_id = ?
					             ))
					     ELSE 0 END AS attention_unread_count
				 FROM channels c
			 LEFT JOIN users owner ON owner.id = c.created_by
			 WHERE c.kind IN ('public', 'private')
			   AND c.deleted_at IS NULL
				   AND (c.kind = 'public' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?))
				 ORDER BY
				   CASE WHEN c.name = 'general' THEN 0 ELSE 1 END,
				   CASE c.kind WHEN 'public' THEN 0 ELSE 1 END,
				   c.name ASC`,
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
					normalizedUserId,
				normalizedUserId,
				normalizedUserId,
				normalizedUserId,
			)
		.all();
	return results.map(mapVisibleChannel);
}

export async function listAdminChannels(db, { includeAvatar = true } = {}) {
	const { results } = await db
		.prepare(
				`SELECT
				   c.id, c.name, c.description, c.avatar_key, c.kind, c.created_at,
				   CASE WHEN c.name = 'general' THEN 1 ELSE 0 END AS is_general,
			   owner.display_name AS owner_display_name,
			   (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = c.id) AS member_count,
			   (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL) AS message_count
			 FROM channels c
			 LEFT JOIN users owner ON owner.id = c.created_by
				 WHERE c.deleted_at IS NULL AND c.kind IN ('public', 'private')
				 ORDER BY CASE WHEN c.name = 'general' THEN 0 ELSE 1 END, c.created_at DESC`,
		)
		.all();
	return results.map((row) => mapAdminChannel(row, includeAvatar));
}

export async function listChannelMembers(db, channelId) {
	const { results } = await db
		.prepare(
			`SELECT cm.user_id, cm.role, cm.joined_at, u.username, u.display_name, u.avatar_key
			 FROM channel_members cm
			 JOIN users u ON u.id = cm.user_id
			 WHERE cm.channel_id = ? AND u.deleted_at IS NULL
			 ORDER BY CASE cm.role WHEN 'owner' THEN 0 ELSE 1 END, u.display_name ASC`,
		)
		.bind(Number(channelId))
		.all();
	return results.map((row) => ({
		id: Number(row.user_id),
		username: row.username,
		displayName: row.display_name,
		avatarUrl: row.avatar_key ? publicFileUrl(row.avatar_key) : "",
		role: row.role,
		joinedAt: row.joined_at,
	}));
}
