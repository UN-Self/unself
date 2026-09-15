// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/unread.js（GPL-3.0-only，裁剪版）
import { activeUserSql } from "../user-status.js";

async function resolveReadableMessageId(db, channelId, messageId = null) {
	const filters = ["channel_id = ?", "deleted_at IS NULL"];
	const binds = [Number(channelId)];
	if (messageId !== null && messageId !== undefined) {
		filters.push("id <= ?");
		binds.push(Number(messageId));
	}
	const { results } = await db
		.prepare(`SELECT COALESCE(MAX(id), 0) AS message_id FROM messages WHERE ${filters.join(" AND ")}`)
		.bind(...binds)
		.all();
	return Number(results[0]?.message_id || 0);
}

export async function markRoomRead(db, { channelId, userId, messageId = null }) {
	const lastReadMessageId = await resolveReadableMessageId(db, channelId, messageId);
	await db
		.prepare(
			`INSERT INTO message_reads (channel_id, user_id, last_read_message_id, updated_at)
			 VALUES (?, ?, ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(channel_id, user_id) DO UPDATE
			 SET last_read_message_id = MAX(message_reads.last_read_message_id, excluded.last_read_message_id),
			     updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(Number(channelId), Number(userId), lastReadMessageId)
		.run();
	return lastReadMessageId;
}

export async function countUnreadMessages(db, { channelId, userId }) {
	const { results } = await db
		.prepare(
				`SELECT COUNT(*) AS unread_count FROM messages m
				 WHERE m.channel_id = ? AND m.deleted_at IS NULL
				   AND (m.sender_id IS NULL OR m.sender_id != ?)
			   AND m.id > COALESCE((SELECT mr.last_read_message_id FROM message_reads mr
			                            WHERE mr.channel_id = ? AND mr.user_id = ?), 0)`,
		)
		.bind(Number(channelId), Number(userId), Number(channelId), Number(userId))
		.all();
	return Number(results[0]?.unread_count || 0);
}

export async function countUnreadAttention(db, { channelId, userId }) {
	const { results } = await db
		.prepare(
				`SELECT COUNT(*) AS unread_count
				 FROM messages m
				 WHERE m.channel_id = ?
				   AND m.deleted_at IS NULL
				   AND m.id > COALESCE((SELECT mr.last_read_message_id
				                            FROM message_reads mr
				                            WHERE mr.channel_id = ? AND mr.user_id = ?), 0)
				   AND (m.sender_id IS NULL OR m.sender_id != ?)
				   AND (
				     EXISTS (
				       SELECT 1
				       FROM json_each(COALESCE(m.mention_user_ids, '[]')) mention_ids
				       WHERE CAST(mention_ids.value AS INTEGER) = ?
				     )
				     OR m.reply_to_sender_id = ?
				   )`,
			)
			.bind(
				Number(channelId),
				Number(channelId),
				Number(userId),
				Number(userId),
				Number(userId),
				Number(userId),
			)
			.all();
	return Number(results[0]?.unread_count || 0);
}

// 协议沿用 mentionUnreadCount 兼容旧客户端，但计数语义与外部桥接一致：同时覆盖提及和回复。
export const countUnreadMentions = countUnreadAttention;

export async function listRoomMemberIds(db, channelId) {
	const { results } = await db
		.prepare(
			`SELECT cm.user_id
			 FROM channel_members cm
			 JOIN users u ON u.id = cm.user_id
			 WHERE cm.channel_id = ?
			   AND u.deleted_at IS NULL
			   AND ${activeUserSql("u")}`,
		)
		.bind(Number(channelId))
		.all();
	return results
		.map((row) => Number(row.user_id))
		.filter((userId) => Number.isFinite(userId));
}
