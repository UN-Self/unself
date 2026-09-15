// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/channel-deletion.ts（GPL-3.0-only，裁剪版）
interface Statement {
	bind(...values: number[]): Statement;
}

interface Database {
	prepare(sql: string): Statement;
	batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>;
}

function placeholders(length: number) {
	return Array.from({ length }, () => "?").join(", ");
}

// API 和历史群组 GC 共用这一事务，避免不同入口遗漏关联记录或继续占用群名。
export async function hardDeleteChannel(db: Database, channelId: number) {
	return hardDeleteChannels(db, [channelId]);
}

export async function hardDeleteChannels(db: Database, channelIds: number[]) {
	const ids = [...new Set(channelIds.map(Number).filter(Number.isInteger))];
	if (!ids.length) {
		return {
			channelsDeleted: 0,
			channelMessagesDeleted: 0,
			channelMembersDeleted: 0,
			r2DeleteQueued: 0,
		};
	}
	const target = `SELECT id FROM channels
			WHERE id IN (${placeholders(ids.length)})
			  AND kind IN ('public', 'private') AND name != 'general'`;
	const [queued, messages, members, , channel] = await db.batch([
		// 文件键先持久化再删消息；R2 由已有队列分批清理，失败或进程中断也不会丢失任务。
		db.prepare(
			`INSERT OR IGNORE INTO pending_r2_delete (object_key)
			 SELECT attachment_key FROM messages
			 WHERE channel_id IN (${target}) AND attachment_key IS NOT NULL AND attachment_key != ''
			 UNION
			 SELECT avatar_key FROM channels
			 WHERE id IN (${target}) AND avatar_key IS NOT NULL AND avatar_key != ''`,
			).bind(...ids, ...ids),
		db.prepare(`DELETE FROM messages WHERE channel_id IN (${target})`).bind(...ids),
		db.prepare(`DELETE FROM channel_members WHERE channel_id IN (${target})`).bind(...ids),
		// 已读游标没有级联外键，必须先显式删除；置顶、同步事件由外键级联。
		db.prepare(`DELETE FROM message_reads WHERE channel_id IN (${target})`).bind(...ids),
		db.prepare(`DELETE FROM channels WHERE id IN (${target})`).bind(...ids),
	]);

	return {
		channelsDeleted: channel.meta.changes,
		channelMessagesDeleted: messages.meta.changes,
		channelMembersDeleted: members.meta.changes,
		r2DeleteQueued: queued.meta.changes,
	};
}
