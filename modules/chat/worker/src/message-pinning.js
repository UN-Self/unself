// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/message-pinning.js（GPL-3.0-only，裁剪版）
import { getPinnedMessage, pinMessage, unpinMessage } from "./data/pins.js";
import { authorizeChannelManagement } from "./room-access.js";

export class MessagePinningError extends Error {
	constructor(message) {
		super(message);
		this.name = "MessagePinningError";
	}
}

function normalizeMessageId(payload) {
	const messageId = Number(payload.messageId);
	if (!Number.isInteger(messageId) || messageId <= 0) {
		throw new MessagePinningError("消息不存在");
	}
	return messageId;
}

async function requirePinPermission(authorize, env, meta) {
	const access = await authorize(env.DB, meta.principal, meta.room.id);
	if (!access.ok) {
		throw new MessagePinningError("无权管理置顶消息");
	}
	return access;
}

export function createMessagePinning({
	authorize = authorizeChannelManagement,
	persistPin = pinMessage,
	loadPinnedMessage = getPinnedMessage,
} = {}) {
	return async function pinRoomMessage(env, meta, payload) {
		const messageId = normalizeMessageId(payload);
		const access = await requirePinPermission(authorize, env, meta);
		const pinned = await persistPin(env.DB, {
			channelId: meta.room.id,
			messageId,
			pinnedBy: access.identity.userId,
		});
		if (!pinned) {
			throw new MessagePinningError("消息不存在或已被删除");
		}

		const message = await loadPinnedMessage(env, meta.room.id);
		if (!message) {
			throw new MessagePinningError("消息不存在或已被删除");
		}
		return {
			message,
			packet: JSON.stringify({ protocolVersion: 1, type: "message_pinned", message }),
		};
	};
}

export function createMessageUnpinning({
	authorize = authorizeChannelManagement,
	persistUnpin = unpinMessage,
} = {}) {
	return async function unpinRoomMessage(env, meta, payload) {
		const messageId = normalizeMessageId(payload);
		await requirePinPermission(authorize, env, meta);
		const unpinned = await persistUnpin(env.DB, {
			channelId: meta.room.id,
			messageId,
		});
		if (!unpinned) {
			throw new MessagePinningError("该消息已不再置顶");
		}
		return {
			messageId,
			packet: JSON.stringify({ protocolVersion: 1, type: "message_unpinned", messageId }),
		};
	};
}

export const pinRoomMessage = createMessagePinning();
export const unpinRoomMessage = createMessageUnpinning();
