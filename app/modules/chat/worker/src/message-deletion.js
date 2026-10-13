// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/message-deletion.js（GPL-3.0-only，裁剪版）
import { getDeletionNotice } from "./data/deletion-notice.js";
import { cleanupR2Keys } from "./gc.js";
import { getMessageDeletionTarget, softDeleteMessage } from "./data/messages.js";
import { authorizeRoom, getChannelMembership } from "./room-access.js";

export class MessageDeletionError extends Error {
	constructor(message) {
		super(message);
		this.name = "MessageDeletionError";
	}
}

export function createMessageDeletion({
    authorize = authorizeRoom,
	persistDeletion = softDeleteMessage,
	getDeletionTarget = getMessageDeletionTarget,
	cleanupAttachments = cleanupR2Keys,
} = {}) {
	return async function deleteRoomMessage(env, meta, payload) {
		const messageId = Number(payload.messageId);
		if (!Number.isInteger(messageId) || messageId <= 0) {
			throw new MessageDeletionError("消息不存在");
		}

        const access = await authorize(
			env.DB,
			meta.principal,
			meta.room.kind,
			meta.room.id,
		);
        if (!access.ok) {
			throw new MessageDeletionError("无权删除该消息");
		}

		const target = await getDeletionTarget(env.DB, messageId);
		if (!target || Number(target.channel_id) !== Number(meta.room.id)) {
			throw new MessageDeletionError("消息不存在或已被删除");
		}
		const actorId = Number(meta.principal.userId);
		const ownMessage = Number(target.sender_id) === actorId;
		let allowAny = meta.principal.isAdmin === true;
		const createdAt = Date.parse(String(target.created_at || "").replace(" ", "T") + (String(target.created_at || "").includes("Z") ? "" : "Z"));
		if (target.channel_kind === "dm") {
			if (!ownMessage) throw new MessageDeletionError("只能撤回自己的消息");
			if (!allowAny && (!Number.isFinite(createdAt) || Date.now() - createdAt > 24 * 60 * 60 * 1000)) {
				throw new MessageDeletionError("消息已超过 24 小时撤回期限");
			}
		} else {
			const membership = await getChannelMembership(env.DB, meta.room.id, actorId);
			const owner = membership?.role === "owner";
			if (!owner && !allowAny && !ownMessage) throw new MessageDeletionError("无权删除该消息");
			if (!owner && !allowAny) {
				if (!Number.isFinite(createdAt) || Date.now() - createdAt > 24 * 60 * 60 * 1000) {
					throw new MessageDeletionError("消息已超过 24 小时撤回期限");
				}
			}
			allowAny = allowAny || owner;
		}
		let attachmentKey = env.FILES ? target.attachment_key || null : null;

		const deleted = await persistDeletion(env.DB, {
			channelId: meta.room.id,
			messageId,
			actorId,
			allowAny,
			action: ownMessage ? "recalled" : "removed",
			source: String(payload.source || "chat"),
		});
		if (!deleted) {
			throw new MessageDeletionError("消息不存在或已被删除");
		}

		const cleanupPromise = attachmentKey
			? Promise.resolve().then(() => cleanupAttachments(env, [attachmentKey])).catch((error) => {
					console.warn("Failed to clean up deleted message attachment", error);
				})
			: null;

		const deletion = await getDeletionNotice(env.DB, messageId);
		return {
			deletion,
			messageId,
			packet: JSON.stringify({ protocolVersion: 1, type: "message_deleted", messageId, deletion }),
			cleanupPromise,
		};
	};
}

export const deleteRoomMessage = createMessageDeletion();
