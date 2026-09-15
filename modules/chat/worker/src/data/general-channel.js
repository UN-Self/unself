// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/general-channel.js（GPL-3.0-only，裁剪版）
export const GENERAL_CHANNEL_NAME = "general";

export function isGeneralChannel(channel) {
	return channel?.kind !== "dm" && channel?.name === GENERAL_CHANNEL_NAME;
}

export function isReservedGeneralChannelName(name) {
	return String(name || "").trim().toLowerCase() === GENERAL_CHANNEL_NAME;
}

export async function ensureGeneralChannelMembership(db, userId) {
	const normalizedUserId = Number(userId);
	if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
		throw new TypeError("general 群组成员必须是有效用户");
	}

	// 运行时继续做幂等修复，避免漏跑迁移或历史异常数据让当前用户失去系统群访问权。
	await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO channels (name, description, kind, created_by)
				 VALUES (?, '', 'public', NULL)`,
			)
			.bind(GENERAL_CHANNEL_NAME),
		db
			.prepare(
				`INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
				 SELECT c.id, ?, 'member', NULL
				 FROM channels c
				 WHERE c.name = ?
				   AND c.kind = 'public'
				   AND c.deleted_at IS NULL`,
			)
			.bind(normalizedUserId, GENERAL_CHANNEL_NAME),
	]);
}
