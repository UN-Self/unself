// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/replies.js（GPL-3.0-only，裁剪版）
function normalizeReplyMessageId(value) {
	if (value === null || value === undefined || value === "") {
		return null;
	}
	const messageId = Number(value);
	if (!Number.isInteger(messageId) || messageId <= 0) {
		throw new Error("Reply message is not available");
	}
	return messageId;
}

function mapReplyReference(row) {
	return {
		messageId: Number(row.id),
		senderId: row.sender_id === null || row.sender_id === undefined
			? null
			: Number(row.sender_id),
	};
}

export async function resolveMessageReply(db, { channelId, replyMessageId }) {
	const messageId = normalizeReplyMessageId(replyMessageId);
	if (messageId === null) {
		return { messageId: null, senderId: null };
	}
	const { results } = await db
		.prepare(
			`SELECT id, sender_id
			 FROM messages
			 WHERE id = ? AND channel_id = ? AND deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(messageId, Number(channelId))
		.all();
	if (!results[0]) {
		throw new Error("Reply message is not available");
	}
	return mapReplyReference(results[0]);
}

export async function findMessageReplyBySource(db, {
	channelId,
	source,
	sourceMessageId,
}) {
	if (!sourceMessageId) return null;
	const { results } = await db
		.prepare(
			`SELECT id, sender_id
			 FROM messages
			 WHERE channel_id = ? AND source = ? AND source_message_id = ? AND deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(Number(channelId), String(source), String(sourceMessageId))
		.all();
	return results[0] ? mapReplyReference(results[0]) : null;
}

export async function getMessageSourceReference(db, { channelId, messageId }) {
	const normalizedMessageId = normalizeReplyMessageId(messageId);
	if (normalizedMessageId === null) return null;
	const { results } = await db
		.prepare(
			`SELECT source, source_message_id
			 FROM messages
			 WHERE id = ? AND channel_id = ? AND deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(normalizedMessageId, Number(channelId))
		.all();
	if (!results[0]?.source_message_id) return null;
	return {
		source: String(results[0].source || "edgechat"),
		sourceMessageId: String(results[0].source_message_id),
	};
}
