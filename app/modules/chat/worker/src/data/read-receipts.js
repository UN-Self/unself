// SPDX-License-Identifier: GPL-3.0-only
// #220 增补（unself 集成层）：逐条已读回执数据面（flows.md 链路 2 落地）。
// 与 message_reads（上游频道级未读游标）并存不互改；幂等锚点=PRIMARY KEY(message_id, user_id)。
import { activeUserSql } from "../user-status.js";

/**
 * 批量落已读回执（幂等）：INSERT OR IGNORE + 批内去重（同批重复 messageId 只算一次）。
 * 先按「消息确属该频道且未删除」过滤（跨房上报=零写入），再逐条幂等落行。
 * #229 服务端兜底：发件人自读直接跳过（决策 #52「发件人恒已读、不计入分母」的强制，
 * 客户端 myUserId 失效时口径也不失真）。
 * 回 newlyRead = 本批真实新增的 {messageId, readAt}——重放=空数组，DO 据此决定是否广播。
 */
export async function recordReadReceipts(db, { channelId, userId, messageIds }) {
	const uniqueIds = [...new Set((Array.isArray(messageIds) ? messageIds : [])
		.map((id) => Number(id))
		.filter((id) => Number.isInteger(id) && id > 0))];
	if (uniqueIds.length === 0) {
		return [];
	}

	// json_each 只占一个绑定参数，200 条批次仍低于 D1 的 100 参数限制。
	// 主键定位请求中的消息；一条原子语句过滤权限范围、自读和重复回执，
	// RETURNING 只返回新插入行，重放不广播，也不逐条往返 D1。
	const { results } = await db.prepare(
		`INSERT OR IGNORE INTO read_receipts (message_id, user_id)
		 SELECT id, ? FROM messages
		 WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
		   AND channel_id = ? AND deleted_at IS NULL
		   AND (sender_id IS NULL OR sender_id != ?)
		 RETURNING message_id, read_at`,
	).bind(Number(userId), JSON.stringify(uniqueIds), Number(channelId), Number(userId)).all();
	return results.map((row) => ({ messageId: Number(row.message_id), readAt: String(row.read_at || '') }));
}

/**
 * 回执补拉（GET /api/messages 富化）：每页一条回执 IN 查询，不 N+1。
 * 回 Map<messageId, {count, readBy:[{userId, username, displayName, readAt}]}>。
 */
export async function listReadReceipts(db, messageIds) {
	const ids = [...new Set((Array.isArray(messageIds) ? messageIds : [])
		.map((id) => Number(id))
		.filter((id) => Number.isInteger(id) && id > 0))];
	const byMessage = new Map();
	if (ids.length === 0) {
		return byMessage;
	}

	const placeholders = ids.map(() => '?').join(', ');
	const { results } = await db
		.prepare(
			`SELECT rr.message_id, rr.user_id, rr.read_at,
			        u.username, u.display_name
			 FROM read_receipts rr
			 JOIN users u ON u.id = rr.user_id
			 WHERE rr.message_id IN (${placeholders})
			 ORDER BY rr.read_at ASC, rr.user_id ASC`,
		)
		.bind(...ids)
		.all();
	for (const row of results) {
		const messageId = Number(row.message_id);
		let entry = byMessage.get(messageId);
		if (!entry) {
			entry = { count: 0, readBy: [] };
			byMessage.set(messageId, entry);
		}
		entry.count += 1;
		entry.readBy.push({
			userId: Number(row.user_id),
			username: String(row.username || ''),
			displayName: String(row.display_name || ''),
			readAt: String(row.read_at || ''),
		});
	}
	return byMessage;
}

/**
 * 可达收件人基数（口径同 listRoomMemberIds）：成员 ∧ 未删 ∧ active（访客/停用不计）。
 * 发件人「恒已读不计分母」由调用方按每条消息自行扣减（一页一次查询）。
 */
export async function countReachableRecipients(db, channelId) {
	const { results } = await db
		.prepare(
			`SELECT COUNT(*) AS recipient_count
			 FROM channel_members cm
			 JOIN users u ON u.id = cm.user_id
			 WHERE cm.channel_id = ?
			   AND u.deleted_at IS NULL
			   AND ${activeUserSql('u')}`,
		)
		.bind(Number(channelId))
		.all();
	return Number(results[0]?.recipient_count || 0);
}
