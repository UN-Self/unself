// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/unread-projection.js（GPL-3.0-only，裁剪版）
import {
	countUnreadAttention,
	countUnreadMentionAll,
	countUnreadMessages,
	listRoomMemberIds,
} from "./data/unread.js";
import { replaceMentionTokens } from "./data/mentions.js";
import { notifyUserInbox } from "./do-bridge.js";

function logProjectionFailure(message, data) {
	console.warn(JSON.stringify({ message, ...data }));
}

export function createUnreadProjection({
	countUnread = countUnreadMessages,
	countMentions = countUnreadAttention,
	countMentionAll = countUnreadMentionAll,
	listMemberIds = listRoomMemberIds,
	notifyInbox = notifyUserInbox,
	logFailure = logProjectionFailure,
} = {}) {
	async function notifyRecipient(env, room, message, userId, replyToSenderId) {
		try {
			const mentionsMe = (message.mentionUserIds || []).includes(Number(userId));
			const replyToMe =
				Number(replyToSenderId ?? message.replyTo?.sender?.id) === Number(userId) &&
				(replyToSenderId !== null && replyToSenderId !== undefined
					? true
					: message.replyTo?.sender?.kind === "local");
			// @all 对所有非发送成员都触发关注（mentionsMe 不含它，两类红标独立——契约 4.1）。
			const mentionedByAll = message.mentionAll === true;
			const needsAttention = mentionsMe || replyToMe || mentionedByAll;
			const [unreadCount, mentionUnreadCount, mentionAllUnreadCount] = await Promise.all([
				countUnread(env.DB, { channelId: room.id, userId }),
				mentionsMe || replyToMe
					? countMentions(env.DB, { channelId: room.id, userId })
					: Promise.resolve(undefined),
				mentionedByAll
					? countMentionAll(env.DB, { channelId: room.id, userId })
					: Promise.resolve(undefined),
			]);
			await notifyInbox(env, userId, {
				protocolVersion: 1,
				type: "room_message",
				room: {
					id: Number(room.id),
					kind: room.kind,
					name: room.name,
				},
				messageId: Number(message.id),
				createdAt: message.createdAt,
				unreadCount,
				...(mentionUnreadCount === undefined ? {} : { mentionUnreadCount }),
				...(mentionAllUnreadCount === undefined ? {} : { mentionAllUnreadCount }),
				mentionsMe,
				mentionedByAll,
				replyToMe,
				// 预览里的 `@username` token 换成 @displayName（只换显示；message.mentions 是读时 JOIN 结果）
				contentPreview: replaceMentionTokens(String(message.content || ""), message.mentions).slice(0, 160),
				sender: message.sender,
			});
		} catch (error) {
			logFailure("unread recipient projection failed", {
				roomId: Number(room.id),
				userId: Number(userId),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return async function projectUnreadMessage(
		env,
		{ room, senderId, message, replyToSenderId = null },
	) {
		try {
			const memberIds = await listMemberIds(env.DB, room.id);
			const recipientIds = memberIds.filter(
				(userId) => Number(userId) !== Number(senderId),
			);
			await Promise.all(
				recipientIds.map((userId) =>
					notifyRecipient(env, room, message, userId, replyToSenderId),
				),
			);
		} catch (error) {
			logFailure("unread projection failed", {
				roomId: Number(room.id),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
}

export const projectUnreadMessage = createUnreadProjection();
