// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/dm-provisioning.js（GPL-3.0-only，裁剪版）
export async function ensureDmChannel(db, actorId, targetUserId) {
	const dmKey = [Number(actorId), Number(targetUserId)]
		.sort((left, right) => left - right)
		.join(":");
	const existing = await db
		.prepare(
			`SELECT id, name, dm_key FROM channels
			 WHERE kind = 'dm' AND dm_key = ? AND deleted_at IS NULL LIMIT 1`,
		)
		.bind(dmKey)
		.all();
	if (existing.results[0]) {
		return existing.results[0];
	}

	const created = await db
		.prepare(
			`INSERT INTO channels (name, description, kind, dm_key, created_by)
			 VALUES (?, '', 'dm', ?, ?)`,
		)
		.bind(dmKey, dmKey, Number(actorId))
		.run();
	const channelId = created.meta.last_row_id;
	await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
				 VALUES (?, ?, 'member', ?)`,
			)
			.bind(channelId, Number(actorId), Number(actorId)),
		db
			.prepare(
				`INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
				 VALUES (?, ?, 'member', ?)`,
			)
			.bind(channelId, Number(targetUserId), Number(actorId)),
	]);
	return { id: channelId, name: dmKey, dm_key: dmKey };
}
