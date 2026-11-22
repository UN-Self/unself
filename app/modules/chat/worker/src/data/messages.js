// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/messages.js（GPL-3.0-only，裁剪版）
import { mapDeletionNotice, getDeletionNotice } from "./deletion-notice.js";
import { blockText, normalizeMessageBlocks } from "../message-blocks.js";
import { userAvatarUrl } from "../profile-avatar.js";
import { decryptMessageContent, encryptMessageContent } from "../encryption.js";
import { pickAttachment, publicFileUrl } from "../utils.js";
import { normalizeMentionUserIds, replaceMentionTokens } from "./mentions.js";
import { fileBelongsToUser, isR2ObjectUnavailableError } from "./uploaded-files.js";
import { projectLoginName } from "./users.js";

function toNullableNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function mapAttachment(row) {
	if (!row.attachment_key) return null;
	const attachment = {
		key: row.attachment_key,
		name: row.attachment_name,
		type: row.attachment_type,
		size: toNullableNumber(row.attachment_size) || 0,
		url: publicFileUrl(row.attachment_key),
	};
	if (row.attachment_kind === "voice" || row.attachment_kind === "audio") {
		attachment.kind = row.attachment_kind;
		attachment.durationMs = toNullableNumber(row.attachment_duration_ms) || 0;
		if (row.attachment_kind === "voice") {
			attachment.waveform = JSON.parse(row.attachment_waveform || "[]");
		}
	}
	return attachment;
}

function mapReplyAttachment(row) {
	if (!row.reply_attachment_key) return null;
	const attachment = {
		key: row.reply_attachment_key,
		name: row.reply_attachment_name,
		type: row.reply_attachment_type,
		size: toNullableNumber(row.reply_attachment_size) || 0,
		url: publicFileUrl(row.reply_attachment_key),
	};
	if (row.reply_attachment_kind === "voice" || row.reply_attachment_kind === "audio") {
		attachment.kind = row.reply_attachment_kind;
		attachment.durationMs = toNullableNumber(row.reply_attachment_duration_ms) || 0;
	}
	return attachment;
}

function mapReplySender(row) {
	const isExternal = row.reply_sender_kind === "external";
	return {
		kind: isExternal ? "external" : "local",
		id: isExternal ? String(row.reply_external_sender_id || "") : Number(row.reply_sender_id),
		username: isExternal ? "" : row.reply_sender_username,
		displayName: isExternal ? row.reply_external_sender_name : row.reply_sender_display_name,
		avatarUrl: isExternal
			? row.reply_external_sender_avatar_url || ""
			: userAvatarUrl(row.reply_core_avatar_url, row.reply_sender_avatar_key),
		source: isExternal ? row.reply_source : "edgechat",
	};
}

export function mapMessage(row, content = row.content, replyTo = null) {
	const isExternal = row.sender_kind === "external";
	const mentions = JSON.parse(row.mentions_json || "[]").map((mention) => ({
		userId: Number(mention.userId),
		username: mention.username,
		displayName: mention.displayName,
	}));
	const message = {
		id: Number(row.id),
		content,
		mentionUserIds: normalizeMentionUserIds(JSON.parse(row.mention_user_ids || "[]")),
		// @all：仅群主提交且服务端复核通过才置 1（message-submission.resolveMessageMentionAll）。
		mentionAll: Number(row.mention_all) === 1,
		mentions,
		createdAt: row.created_at,
		source: row.source || "edgechat",
		sender: {
				kind: isExternal ? "external" : "local",
				id: isExternal ? String(row.external_sender_id || "") : Number(row.sender_id),
				username: isExternal ? "" : row.sender_username,
				displayName: isExternal ? row.external_sender_name : row.sender_display_name,
				avatarUrl: isExternal
					? row.external_sender_avatar_url || ""
					: userAvatarUrl(row.sender_core_avatar_url, row.sender_avatar_key),
				// #透传：真实登录名（`core:<sub>` 幂等锚点不外露）；external 与本地注册用户省略，
				// 来源未知时也省略——只有明确 OIDC 才输出 null 让资料卡显示占位。
				loginName: isExternal || !String(row.sender_username || '').startsWith("core:")
					? undefined
					: projectLoginName(row.sender_core_login_name, row.sender_core_identity_source),
				source: isExternal ? row.source : "edgechat",
			},
			attachment: mapAttachment(row),
	};
	if (row.client_message_id) {
		message.clientMessageId = row.client_message_id;
	}
	if (row.reply_to_message_id) {
		message.replyToMessageId = Number(row.reply_to_message_id);
		message.replyTo = replyTo || {
			id: Number(row.reply_to_message_id),
			deleted: true,
		};
	}
	return message;
}

export async function externalSenderExists(db, source, senderId) {
	const { results } = await db
		.prepare(
			`SELECT 1 AS found
			 FROM messages
			 WHERE sender_kind = 'external'
			   AND source = ?
			   AND external_sender_id = ?
			   AND deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(String(source), String(senderId))
		.all();
	return Boolean(results[0]);
}

async function mapDecryptedMessage(env, row) {
	if (row.deleted_at) {
		return {
			...mapMessage(row, "", null),
			deleted: true,
			deletion: mapDeletionNotice(row),
			attachment: null,
			mentions: [],
			mentionUserIds: [],
			replyTo: undefined,
			replyToMessageId: undefined,
		};
	}
	const content = await decryptMessageContent(env, row.content, {
		channelId: row.channel_id,
		senderId: row.sender_id ?? 0,
		senderContext:
			row.sender_kind === "external" ? `${row.source}:${row.external_sender_id}` : "",
	});
	let replyTo = null;
	if (row.reply_to_message_id) {
		const replyId = Number(row.reply_to_message_id);
		if (!row.reply_message_id || row.reply_deleted_at) {
			replyTo = { id: replyId, deleted: true };
		} else {
			const replyContent = await decryptMessageContent(env, row.reply_content, {
				channelId: row.channel_id,
				senderId: row.reply_sender_id ?? 0,
				senderContext:
					row.reply_sender_kind === "external"
						? `${row.reply_source}:${row.reply_external_sender_id}`
						: "",
			});
			replyTo = {
				id: replyId,
				deleted: false,
				// 引用块正文里的 @token 重写为显示名（引用块是纯文本渲染，无 mentions 上下文）。
				// replaceMentionTokens 带词边界 + username 最长优先（`@core:1` 是 `@core:12` 的前缀），
				// 与 unread-projection / message-preview 同一实现，转发写入侧（forward-submission）亦复用
				content: replaceMentionTokens(replyContent, JSON.parse(row.reply_mentions_json || "[]")),
				sender: mapReplySender(row),
				attachment: mapReplyAttachment(row),
			};
		}
	}
	const message = mapMessage(row, content, replyTo);
	if (row.content_blocks) {
		message.blocks = JSON.parse(await decryptMessageContent(env, row.content_blocks, {
			channelId: row.channel_id, senderId: row.sender_id ?? 0,
		}));
	}
	return message;
}

const MESSAGE_SELECT = `SELECT
		  m.id, m.channel_id, da.actor_user_id AS deletion_actor_id, du.display_name AS deletion_actor_name, m.content, bp.content_blocks, m.attachment_key, m.attachment_name, m.attachment_type,
		  m.attachment_size, m.attachment_kind, m.attachment_duration_ms, m.attachment_waveform,
		  m.sender_kind, m.external_sender_id, m.external_sender_name,
		  m.external_sender_avatar_url, m.source, m.source_message_id,
		  m.source_attachment_id, m.source_attachment_unique_id, m.client_message_id,
				  m.mention_user_ids, m.mention_all, m.reply_to_message_id, m.reply_to_sender_id, m.created_at, m.deleted_at,
		  u.id AS sender_id, u.username AS sender_username,
		  u.display_name AS sender_display_name, u.avatar_key AS sender_avatar_key, u.core_avatar_url AS sender_core_avatar_url,
		  u.core_login_name AS sender_core_login_name,
		  u.core_identity_source AS sender_core_identity_source,
		  reply.id AS reply_message_id, reply.content AS reply_content,
		  reply.deleted_at AS reply_deleted_at,
		  reply.attachment_key AS reply_attachment_key,
		  reply.attachment_name AS reply_attachment_name,
		  reply.attachment_type AS reply_attachment_type,
		  reply.attachment_size AS reply_attachment_size,
		  reply.attachment_kind AS reply_attachment_kind,
		  reply.attachment_duration_ms AS reply_attachment_duration_ms,
		  reply.sender_kind AS reply_sender_kind,
		  reply.external_sender_id AS reply_external_sender_id,
		  reply.external_sender_name AS reply_external_sender_name,
		  reply.external_sender_avatar_url AS reply_external_sender_avatar_url,
		  reply.source AS reply_source,
		  reply_user.id AS reply_sender_id,
		  reply_user.username AS reply_sender_username,
		  reply_user.display_name AS reply_sender_display_name,
		  reply_user.avatar_key AS reply_sender_avatar_key, reply_user.core_avatar_url AS reply_core_avatar_url,
  COALESCE((
    SELECT json_group_array(json_object(
      'userId', mentioned.id,
      'username', mentioned.username,
      'displayName', mentioned.display_name
    ))
    FROM json_each(COALESCE(m.mention_user_ids, '[]')) mention_ids
    JOIN users mentioned ON mentioned.id = CAST(mention_ids.value AS INTEGER)
	 ), '[]') AS mentions_json,
  COALESCE((
    SELECT json_group_array(json_object(
      'userId', reply_mentioned.id,
      'username', reply_mentioned.username,
      'displayName', reply_mentioned.display_name
    ))
    FROM json_each(COALESCE(reply.mention_user_ids, '[]')) reply_mention_ids
    JOIN users reply_mentioned ON reply_mentioned.id = CAST(reply_mention_ids.value AS INTEGER)
	 ), '[]') AS reply_mentions_json
 FROM messages m
   LEFT JOIN message_block_payloads bp ON bp.message_id = m.id
   LEFT JOIN message_deletion_audit da ON da.id = (SELECT id FROM message_deletion_audit WHERE message_id = m.id AND m.deleted_at IS NOT NULL ORDER BY id LIMIT 1)
   LEFT JOIN users du ON du.id = da.actor_user_id
	 LEFT JOIN users u ON u.id = m.sender_id
	 LEFT JOIN messages reply ON reply.id = m.reply_to_message_id
	 LEFT JOIN users reply_user ON reply_user.id = reply.sender_id`;

export async function getMessageDeletionTarget(db, messageId) {
	const { results } = await db
		.prepare(
			`SELECT m.id, m.channel_id, m.sender_id, m.attachment_key, m.created_at,
			        c.kind AS channel_kind
			 FROM messages m
			 JOIN channels c ON c.id = m.channel_id
			 WHERE m.id = ?
			   AND m.deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(Number(messageId))
		.all();
	return results[0] || null;
}

export async function listMessages(env, roomId, before = null, limit = 30) {
	const filters = ["m.channel_id = ?"];
	const binds = [Number(roomId)];
	if (before) {
		filters.push("m.id < ?");
		binds.push(Number(before));
	}
	const { results } = await env.DB
		.prepare(`${MESSAGE_SELECT} WHERE ${filters.join(" AND ")} ORDER BY m.id DESC LIMIT ?`)
		.bind(...binds, Number(limit))
		.all();
	return (await Promise.all(results.map((row) => mapDecryptedMessage(env, row)))).reverse();
}

export async function getMessageById(env, messageId) {
	const { results } = await env.DB
		.prepare(`${MESSAGE_SELECT} WHERE m.id = ? AND m.deleted_at IS NULL LIMIT 1`)
		.bind(Number(messageId))
		.all();
	return results[0] ? mapDecryptedMessage(env, results[0]) : null;
}

export async function getMessageBySource(env, source, sourceMessageId) {
	const { results } = await env.DB
		.prepare(
			`${MESSAGE_SELECT}
			 WHERE m.source = ? AND m.source_message_id = ?
			 LIMIT 1`,
		)
		.bind(String(source), String(sourceMessageId))
		.all();
	return results[0] ? mapDecryptedMessage(env, results[0]) : null;
}

export async function getMessageByClientId(env, channelId, senderId, clientMessageId) {
	const { results } = await env.DB
		.prepare(
			`${MESSAGE_SELECT}
			 WHERE m.channel_id = ?
			   AND m.sender_id = ?
			   AND m.client_message_id = ?
			   AND m.deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(Number(channelId), Number(senderId), String(clientMessageId))
		.all();
	return results[0] ? mapDecryptedMessage(env, results[0]) : null;
}

/** 按 id 批量读取（#347 M1/M2）：转发源消息与落地回读共用，一次查询替代逐条 getMessageById
 * 的 N 次往返；已删除消息按缺失处理（返回 null，与 getMessageById 的口径一致）。 */
export async function getMessagesByIds(env, ids) {
	const normalized = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	if (!normalized.length) return [];
	const placeholders = normalized.map(() => "?").join(", ");
	const { results } = await env.DB
		.prepare(`${MESSAGE_SELECT} WHERE m.id IN (${placeholders}) AND m.deleted_at IS NULL`)
		.bind(...normalized)
		.all();
	const byId = new Map();
	for (const row of results) byId.set(Number(row.id), await mapDecryptedMessage(env, row));
	return normalized.map((id) => byId.get(id) ?? null);
}

/**
 * 按 clientMessageId 批量读取（#347 H1）：转发幂等回显的预检一次查询，返回
 * Map<clientMessageId, message>。仅限同一 (channel_id, sender_id) 内——与唯一索引口径一致。
 */
async function getMessagesByClientIds(env, channelId, senderId, clientIds) {
	const unique = [...new Set(clientIds.map((id) => String(id || "").trim()).filter(Boolean))];
	if (!unique.length) return new Map();
	const placeholders = unique.map(() => "?").join(", ");
	const { results } = await env.DB
		.prepare(
			`${MESSAGE_SELECT}
			 WHERE m.channel_id = ?
			   AND m.sender_id = ?
			   AND m.client_message_id IN (${placeholders})
			   AND m.deleted_at IS NULL`,
		)
		.bind(Number(channelId), Number(senderId), ...unique)
		.all();
	const byClientId = new Map();
	for (const row of results) byClientId.set(String(row.client_message_id), await mapDecryptedMessage(env, row));
	return byClientId;
}

async function hasConsumedClientMessageId(db, channelId, senderId, clientMessageId) {
	const { results } = await db
		.prepare(
			`SELECT id
			 FROM messages
			 WHERE channel_id = ? AND sender_id = ? AND client_message_id = ?
			 LIMIT 1`,
		)
		.bind(Number(channelId), Number(senderId), String(clientMessageId))
		.all();
	return Boolean(results[0]);
}

export async function getRoomSyncCursor(db, channelId) {
	const { results } = await db
		.prepare(
			`SELECT MAX(sequence) AS sequence
			 FROM (
			   SELECT COALESCE(MAX(sequence), 0) AS sequence
			   FROM message_events
			   WHERE channel_id = ?
			   UNION ALL
			   SELECT COALESCE(MAX(compacted_through), 0) AS sequence
			   FROM message_event_compaction
			   WHERE channel_id = ?
			 )`,
		)
		.bind(Number(channelId), Number(channelId))
		.all();
	return Number(results[0]?.sequence || 0);
}

export async function getRoomCompactedCursor(db, channelId) {
	const { results } = await db
		.prepare(
			`SELECT compacted_through
			 FROM message_event_compaction
			 WHERE channel_id = ?
			 LIMIT 1`,
		)
		.bind(Number(channelId))
		.all();
	return Number(results[0]?.compacted_through || 0);
}

export async function listRoomMessageEvents(env, channelId, afterSequence = 0, limit = 100) {
	const normalizedCursor = Number(afterSequence) || 0;
	const compactedThrough = await getRoomCompactedCursor(env.DB, channelId);
	if (normalizedCursor < compactedThrough) {
		const error = new Error("Room sync cursor expired");
		error.name = "RoomSyncCursorExpiredError";
		error.code = "sync_cursor_expired";
		error.status = 409;
		throw error;
	}
	const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 100);
	const { results } = await env.DB
		.prepare(
			`SELECT sequence, message_id, event_type, created_at
			 FROM message_events
			 WHERE channel_id = ? AND sequence > ?
			 ORDER BY sequence ASC
			 LIMIT ?`,
		)
		.bind(Number(channelId), normalizedCursor, pageSize + 1)
		.all();
	const page = results.slice(0, pageSize);
	const events = [];
	for (const row of page) {
		if (row.event_type === "deleted") {
			events.push({
				sequence: Number(row.sequence),
				type: "message_deleted",
				messageId: Number(row.message_id),
				deletion: await getDeletionNotice(env.DB, row.message_id),
				createdAt: row.created_at,
			});
			continue;
		}
		const message = await getMessageById(env, row.message_id);
		if (message) {
			events.push({
				sequence: Number(row.sequence),
				type: "message",
				message,
				createdAt: row.created_at,
			});
		}
	}
	return {
		events,
		nextCursor: page.length
			? Number(page[page.length - 1].sequence)
				: normalizedCursor,
		hasMore: results.length > pageSize,
	};
}

export async function softDeleteMessage(db, { channelId, messageId, actorId, allowAny = false, action = 'recalled', source = 'chat' }) {
	const [updated, audited] = await db.batch([
		db.prepare(
			`UPDATE messages
			 SET deleted_at = CURRENT_TIMESTAMP
			 WHERE id = ? AND channel_id = ? AND deleted_at IS NULL
			   AND (? = 1 OR (sender_id = ? AND created_at >= datetime('now', '-24 hours')))` ,
		).bind(Number(messageId), Number(channelId), allowAny ? 1 : 0, Number(actorId)),
		db.prepare(
			`INSERT OR IGNORE INTO message_deletion_audit
			 (message_id, channel_id, actor_user_id, action, source)
			 SELECT ?, ?, ?, ?, ?
			 WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND channel_id = ? AND deleted_at IS NOT NULL)`,
		).bind(Number(messageId), Number(channelId), Number(actorId), String(action), String(source), Number(messageId), Number(channelId)),
	]);
	return Number(updated.meta?.changes || 0) > 0;
}

const MESSAGE_INSERT_SQL = `INSERT INTO messages (
  channel_id, sender_id, content, attachment_key, attachment_name,
  attachment_type, attachment_size, attachment_kind, attachment_duration_ms,
  attachment_waveform, sender_kind, external_sender_id,
  external_sender_name, external_sender_avatar_url, source, source_message_id,
  source_attachment_id, source_attachment_unique_id, client_message_id,
  mention_user_ids, mention_all, reply_to_message_id, reply_to_sender_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** 附件四列 + 波形两列的公共绑定段（persistMessage 与转发落地共用）。 */
function attachmentColumnsOf(cleanAttachment, isVoiceLike) {
	return [
		cleanAttachment?.key || null,
		cleanAttachment?.name || null,
		cleanAttachment?.type || null,
		cleanAttachment?.size || null,
		cleanAttachment?.kind || null,
		isVoiceLike ? cleanAttachment.durationMs : null,
		cleanAttachment?.kind === "voice" ? JSON.stringify(cleanAttachment.waveform) : null,
	];
}

/**
 * 消息行构建（persistMessage 与转发落地共用的校验/加密/取值口径）：normalize（或 rawBlocks
 * 直通——转发 forward_bundle 是服务端内部载荷，normalize 只认 text/attachment）、附件归属
 * （attachmentOwnerUserId 覆盖校验对象：转发他人消息时附件仍属原作者）、加密正文与 blocks。
 * 返回 INSERT 绑定值与 blocks 载荷（无 blocks 时 storedBlocks 为 null）。
 */
async function buildMessageRow(env, {
	channelId,
	senderId = null,
	externalSender = null,
	content,
	attachment = null,
	blocks = null,
	rawBlocks = null,
	attachmentOwnerUserId = null,
	// 转发落地用：附件归属已由调用方一次批量校验过（forward-submission），跳过逐条
	// fileBelongsToUser 查询——N 条带附件的转发就是 N 个 subrequest，会撞 Workers 上限
	trustAttachmentOwnership = false,
	source = "edgechat",
	sourceMessageId = null,
	clientMessageId = null,
}) {
	const isExternal = externalSender !== null;
	const normalizedSenderId = isExternal ? null : Number(senderId);
	const attachmentOwner = attachmentOwnerUserId ?? normalizedSenderId;
	const cleanBlocks = rawBlocks
		? rawBlocks
		: blocks === null || blocks === undefined ? null : await normalizeMessageBlocks(env.DB, blocks, attachmentOwner);
	if (cleanBlocks && !rawBlocks) {
		content = blockText(cleanBlocks);
		attachment = cleanBlocks.find(block => block.type === 'attachment')?.attachment ?? null;
	}
	const hasAttachment = attachment !== undefined && attachment !== null;
	// 外部附件只能从已验证的内部 Bridge 入口进入；本地客户端仍必须通过上传归属校验。
	const cleanAttachment = pickAttachment(
		attachment,
		isExternal ? {} : { ownerUserId: attachmentOwner },
	);
	const cleanContent = String(content || "").trim();
	if (hasAttachment && !cleanAttachment) {
		throw new Error("Invalid attachment");
	}
	if (
		!isExternal &&
		cleanAttachment &&
		!trustAttachmentOwnership &&
		!(await fileBelongsToUser(env.DB, cleanAttachment.key, attachmentOwner))
	) {
		throw new Error("Attachment is not available");
	}
	if (!cleanContent && !cleanAttachment) {
		throw new Error("Message content cannot be empty");
	}
	const externalId = isExternal ? String(externalSender.id || "").trim() : "";
	const externalName = isExternal ? String(externalSender.displayName || "").trim() : "";
	if (isExternal && (!externalId || !externalName || !sourceMessageId)) {
		throw new Error("External sender is incomplete");
	}

	const storedContent = await encryptMessageContent(env, cleanContent, {
		channelId,
		senderId: normalizedSenderId ?? 0,
		senderContext: isExternal ? `${source}:${externalId}` : "",
	});
	const storedBlocks = cleanBlocks ? await encryptMessageContent(env, JSON.stringify(cleanBlocks), {
		channelId, senderId: normalizedSenderId ?? 0,
	}) : null;
	const attachmentKeys = cleanBlocks ? JSON.stringify(cleanBlocks.filter(block => block.type === 'attachment').map(block => block.attachment.key)) : null;
	const normalizedClientMessageId = isExternal
		? null
		: String(clientMessageId || "").trim() || null;
	const values = [
		Number(channelId),
		normalizedSenderId,
		storedContent,
		...attachmentColumnsOf(
			cleanAttachment,
			cleanAttachment?.kind === "voice" || cleanAttachment?.kind === "audio",
		),
		isExternal ? "external" : "local",
		isExternal ? externalId : null,
		isExternal ? externalName : null,
		isExternal ? String(externalSender.avatarUrl || "") : null,
		String(source || "edgechat"),
		sourceMessageId ? String(sourceMessageId) : null,
	];
	return {
		values,
		storedBlocks,
		attachmentKeys,
		normalizedSenderId,
		normalizedClientMessageId,
	};
}

async function persistMessage(env, {
	channelId,
	senderId = null,
	externalSender = null,
	content,
	attachment = null,
	blocks = null,
	rawBlocks = null,
	attachmentOwnerUserId = null,
	// 转发落地用：附件归属已由调用方一次批量校验过（forward-submission），跳过逐条
	// fileBelongsToUser 查询——N 条带附件的转发就是 N 个 subrequest，会撞 Workers 上限
	trustAttachmentOwnership = false,
	source = "edgechat",
	sourceMessageId = null,
	sourceAttachmentId = null,
	sourceAttachmentUniqueId = null,
	clientMessageId = null,
	mentionUserIds = [],
	mentionAll = 0,
	replyToMessageId = null,
	replyToSenderId = null,
}) {
	const isExternal = externalSender !== null;
	const row = await buildMessageRow(env, {
		channelId, senderId, externalSender, content, attachment, blocks,
		rawBlocks, attachmentOwnerUserId, trustAttachmentOwnership, source, sourceMessageId, clientMessageId,
	});
	const storedMentionUserIds = JSON.stringify(
		isExternal ? [] : normalizeMentionUserIds(mentionUserIds),
	);
	const storedMentionAll = isExternal ? 0 : Number(mentionAll) === 1 ? 1 : 0;
	const normalizedReplyToMessageId = replyToMessageId ? Number(replyToMessageId) : null;
	const normalizedReplyToSenderId = replyToSenderId ? Number(replyToSenderId) : null;
	const values = [
		...row.values,
		sourceAttachmentId ? String(sourceAttachmentId) : null,
		sourceAttachmentUniqueId ? String(sourceAttachmentUniqueId) : null,
		row.normalizedClientMessageId,
		storedMentionUserIds,
		storedMentionAll,
		normalizedReplyToMessageId,
		normalizedReplyToSenderId,
	];
	try {
		const result = await env.DB.prepare(MESSAGE_INSERT_SQL).bind(...values).run();
		if (row.storedBlocks) {
			await env.DB.prepare('INSERT INTO message_block_payloads(message_id,content_blocks,attachment_keys) VALUES(?,?,?)')
				.bind(Number(result.meta.last_row_id), row.storedBlocks, row.attachmentKeys).run();
		}
		return { message: await getMessageById(env, result.meta.last_row_id), created: true };
	} catch (error) {
		if (isR2ObjectUnavailableError(error)) {
			throw new Error("Attachment is not available");
		}
		if (sourceMessageId && String(error?.message || error).includes("UNIQUE")) {
			const existing = await getMessageBySource(env, source, sourceMessageId);
			if (existing) {
				return { message: existing, created: false };
			}
		}
		if (row.normalizedClientMessageId && String(error?.message || error).includes("UNIQUE")) {
			const existing = await getMessageByClientId(
				env,
				channelId,
				row.normalizedSenderId,
				row.normalizedClientMessageId,
			);
			if (existing) {
				return { message: existing, created: false };
			}
			if (
				await hasConsumedClientMessageId(
					env.DB,
					channelId,
					row.normalizedSenderId,
					row.normalizedClientMessageId,
				)
			) {
				throw new Error("Message idempotency key was already consumed");
			}
		}
		throw error;
	}
}

export async function insertMessage(env, {
	channelId,
	senderId,
	content,
	attachment,
	blocks = null,
	clientMessageId = null,
	mentionUserIds = [],
	mentionAll = 0,
	replyToMessageId = null,
	replyToSenderId = null,
}) {
	const result = await persistMessage(env, {
		channelId,
		senderId,
		content,
		attachment,
		blocks,
		clientMessageId,
		mentionUserIds,
		mentionAll,
		replyToMessageId,
		replyToSenderId,
	});
	return result.message;
}

export function insertMessageIdempotent(env, payload) {
	return persistMessage(env, payload);
}

export function insertExternalMessage(env, payload) {
	return persistMessage(env, payload);
}

const MESSAGE_PAYLOAD_BY_CLIENT_SQL = `INSERT INTO message_block_payloads(message_id,content_blocks,attachment_keys)
  SELECT id, ?, ? FROM messages WHERE channel_id = ? AND sender_id = ? AND client_message_id = ?`;

/** D1 唯一约束冲突且命中 client_message_id（#347 H1 的竞态兜底判定）。 */
function isClientMessageIdConflict(error) {
	const message = String(error?.message || "");
	return /UNIQUE constraint failed/i.test(message) && /client_message_id/i.test(message);
}

/**
 * 转发落地（#347）：同 (channel, sender, client_message_id) 已存在时回显旧消息，不重复落地
 * （与普通发送 submitRoomMessageIdempotent 同语义；唯一索引见 0001_baseline）。行构建复用
 * persistMessage 的 buildMessageRow 口径（转发必是本地发送，无 external/引用/@，尾段填空值）。
 * 所有待插消息在同一个 env.DB.batch 内插入——D1 的 batch 是 SQL 事务，任一条失败整体回滚。
 * blocks 载荷与消息同 batch 交错，用 client_message_id 子查询定位刚插入的行（同事务内可见、
 * 唯一索引保证命中唯一），不依赖 last_insert_rowid 的跨语句语义。并发同键竞态靠唯一约束失败
 * → 整体回滚 → 重读回显兜底。createdFlags true = 本次新落地（调用方只广播这些条目）。
 */
export async function insertForwardMessagesAtomic(env, items) {
	if (!Array.isArray(items) || items.length === 0) {
		return { messages: [], createdFlags: [] };
	}
	const channelId = Number(items[0].channelId);
	const senderId = Number(items[0].senderId);
	const keyOf = (item) => String(item.clientMessageId || "").trim();
	const echoOf = () => getMessagesByClientIds(env, channelId, senderId, items.map(keyOf));
	let echoes = await echoOf();
	const createdKeys = new Set();
	if (echoes.size < items.length) {
		const pending = items.filter((item) => !echoes.has(keyOf(item)));
		const preps = await Promise.all(pending.map((item) => buildMessageRow(env, {
			channelId: item.channelId,
			senderId: item.senderId,
			content: item.content,
			attachment: item.attachment ?? null,
			blocks: item.blocks ?? null,
			rawBlocks: item.rawBlocks ?? null,
			attachmentOwnerUserId: item.attachmentOwnerUserId ?? null,
			trustAttachmentOwnership: item.trustAttachmentOwnership === true,
			source: item.source ?? "edgechat",
			clientMessageId: item.clientMessageId,
		})));
		const statements = [];
		for (let index = 0; index < preps.length; index++) {
			const prep = preps[index];
			const payloadKeys = pending[index].attachmentKeysOverride != null
				? JSON.stringify(pending[index].attachmentKeysOverride.map((key) => String(key)))
				: prep.attachmentKeys;
			statements.push(env.DB.prepare(MESSAGE_INSERT_SQL).bind(
				...prep.values,
				null, null, // source_attachment_id / source_attachment_unique_id
				prep.normalizedClientMessageId,
				"[]", 0, // 转发副本不带 @：不点亮高亮、不触发未读红标
				null, null, // reply_to_message_id / reply_to_sender_id
			));
			if (prep.storedBlocks) {
				statements.push(env.DB.prepare(MESSAGE_PAYLOAD_BY_CLIENT_SQL).bind(
					prep.storedBlocks, payloadKeys, channelId, senderId, prep.normalizedClientMessageId,
				));
			}
		}
		try {
			await env.DB.batch(statements);
			for (const item of pending) createdKeys.add(keyOf(item));
			echoes = await echoOf();
		} catch (error) {
			if (!isClientMessageIdConflict(error)) throw error;
			// 竞态：并发提交同键，batch 已整体回滚——全量改走回显
			echoes = await echoOf();
		}
	}
	const messages = items.map((item) => echoes.get(keyOf(item)) ?? null);
	const createdFlags = items.map((item) => createdKeys.has(keyOf(item)));
	return { messages, createdFlags };
}
