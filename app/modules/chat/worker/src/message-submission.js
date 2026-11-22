// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/message-submission.js（GPL-3.0-only，裁剪版）
import { blockText } from "./message-blocks.js";
import { insertMessage, insertMessageIdempotent } from "./data/messages.js";
import { resolveMessageMentionUserIds, contentMentionsAll } from "./data/mentions.js";
import { resolveMessageReply } from "./data/replies.js";
import { getDirectMessageBlockStatus } from "./data/user-blocks.ts";
import { dmBlockRejectionOf } from "./dm-blocks.js";

export class MessageSubmissionError extends Error {
	constructor(message, code = "invalid_request", status = 400) {
		super(message);
		this.name = "MessageSubmissionError";
		this.code = code;
		this.status = status;
	}
}

/**
 * @all（@所有人）复核：仅群主（channel_members.role = 'owner'）可用，DM 恒否。
 * 客户端必须带 mentionAll=true（只有选中候选插入的 @all chip 才会置位，手打文本不算——#347 定案），
 * 且文本含边界包裹的 `@所有人`；任一不满足都静默降级为普通消息
 * （与个人提及的服务端静默复核风格一致；契约见 docs/requirements.md 4.1）。
 */
export async function resolveMessageMentionAll(db, { channelId, roomKind, senderId, content, requested }) {
	if (!requested || roomKind === "dm" || !contentMentionsAll(content)) {
		return 0;
	}
	const row = await db
		.prepare(
			"SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ? AND role = 'owner' LIMIT 1",
		)
		.bind(Number(channelId), Number(senderId))
		.first();
	return row ? 1 : 0;
}

export function createMessageSubmission({
	persistMessage = insertMessage,
	resolveMentions = resolveMessageMentionUserIds,
	resolveMentionAll = resolveMessageMentionAll,
	resolveReply = resolveMessageReply,
	resolveDmBlockStatus = getDirectMessageBlockStatus,
} = {}) {
	return async function submitRoomMessage(env, meta, payload) {
		try {
			if (payload.blocks != null) payload = { ...payload, content: blockText(payload.blocks) };
			if (meta.room.kind === "dm") {
				const blockStatus = await resolveDmBlockStatus(
					env.DB,
					Number(meta.room.id),
					Number(meta.principal.userId),
				);
				const rejection = dmBlockRejectionOf(blockStatus);
				if (rejection) {
					throw new MessageSubmissionError(rejection.message, rejection.code, rejection.status);
				}
			}
			const [mentionUserIds, mentionAll, reply] = await Promise.all([
				resolveMentions(env.DB, {
					channelId: meta.room.id,
					roomKind: meta.room.kind,
					senderId: meta.principal.userId,
					content: payload.content,
					candidateUserIds: payload.mentionUserIds,
				}),
				resolveMentionAll(env.DB, {
					channelId: meta.room.id,
					roomKind: meta.room.kind,
					senderId: meta.principal.userId,
					content: payload.content,
					requested: payload.mentionAll === true,
				}),
				resolveReply(env.DB, {
					channelId: meta.room.id,
					replyMessageId: payload.replyMessageId,
				}),
			]);
			const persistencePayload = {
				channelId: meta.room.id,
				senderId: meta.principal.userId,
				content: payload.content,
				attachment: payload.attachment,
				blocks: payload.blocks,
				mentionUserIds,
				mentionAll,
			};
			if (reply.messageId) {
				persistencePayload.replyToMessageId = reply.messageId;
				persistencePayload.replyToSenderId = reply.senderId;
			}
			if (payload.clientMessageId) {
				persistencePayload.clientMessageId = payload.clientMessageId;
			}
			const persisted = await persistMessage(env, persistencePayload);
			const message = persisted?.message || persisted;
			const created = persisted?.message ? persisted.created !== false : true;
			return {
				message,
				created,
				replyToSenderId: reply.senderId,
				packet: JSON.stringify({ protocolVersion: 1, type: "message", message }),
			};
		} catch (error) {
			if (error?.message === "Invalid message blocks") throw new MessageSubmissionError("图文消息格式无效，最多 10 个附件、20000 字符");
			if (
				error?.message === "Invalid attachment" ||
				error?.message === "Attachment is not available"
			) {
				throw new MessageSubmissionError(
					"附件不存在、无权使用或正在清理，请重新上传",
					"attachment_unavailable",
			);
			}
			if (error?.message === "Message content cannot be empty") {
				throw new MessageSubmissionError("消息内容不能为空");
			}
			if (error?.message === "Message idempotency key was already consumed") {
				throw new MessageSubmissionError(
					"该消息已删除，不能使用相同的 clientMessageId 再次发送",
					"client_message_id_consumed",
					409,
				);
			}
			if (error?.message === "Reply message is not available") {
				throw new MessageSubmissionError(
					"回复的消息不存在或已删除",
					"reply_message_unavailable",
				);
			}
			throw error;
		}
	};
}

export const submitRoomMessage = createMessageSubmission();
export const submitRoomMessageIdempotent = createMessageSubmission({
	persistMessage: insertMessageIdempotent,
});
