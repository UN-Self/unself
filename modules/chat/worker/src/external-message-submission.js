// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/external-message-submission.js（GPL-3.0-only，裁剪版）
import { insertExternalMessage } from "./data/messages.js";

export async function submitExternalMessage(env, { room, payload }) {
	const result = await insertExternalMessage(env, {
		channelId: room.id,
		content: payload.content,
		attachment: payload.attachment,
		externalSender: payload.externalSender,
		source: payload.source,
		sourceMessageId: payload.sourceMessageId,
		sourceAttachmentId: payload.sourceAttachmentId,
		sourceAttachmentUniqueId: payload.sourceAttachmentUniqueId,
		replyToMessageId: payload.replyToMessageId,
		replyToSenderId: payload.replyToSenderId,
	});
	return {
		...result,
		replyToSenderId: payload.replyToSenderId || null,
		packet: JSON.stringify({ type: "message", message: result.message }),
	};
}
