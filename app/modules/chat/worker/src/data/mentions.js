// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/mentions.js（GPL-3.0-only，裁剪版）
import { activeUserSql } from "../user-status.js";

export function normalizeMentionUserIds(values) {
	if (!Array.isArray(values)) {
		return [];
	}
	return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
}

function isMentionBoundary(character) {
	return !character || /[\s()[\]{}<>"'，。！？、：；,.!?]/u.test(character);
}

export function contentMentionsUsername(content, username) {
	const text = String(content || "");
	const token = `@${String(username || "")}`;
	if (token.length <= 1) {
		return false;
	}

	let offset = text.indexOf(token);
	while (offset !== -1) {
		const before = offset > 0 ? text[offset - 1] : "";
		const after = text[offset + token.length] || "";
		if (isMentionBoundary(before) && isMentionBoundary(after)) {
			return true;
		}
		offset = text.indexOf(token, offset + token.length);
	}
	return false;
}

// @all（@所有人）保留名：个人提及永不解析 username 为「所有人」的用户，
// 避免 `@所有人` 同时命中个人提及与 @all 复核（契约 4.1）。
// 主防线是生成规则：唯一建档入口 jit-users.js coreUsername 恒带 `core:` 前缀，
// username 拼不出「所有人」；displayName 同名不受影响（个人提及按 username 复核，
// 走 `@core:<sub>` 即可精确提及）。下面这行过滤只是防御——未来若加允许裸 username
// 的导入/注册路径，必须在入口拒绝或改名「所有人」，不能只靠这里。
const MENTION_ALL_NAME = "所有人";

export function contentMentionsAll(content) {
	return contentMentionsUsername(content, MENTION_ALL_NAME);
}

// 预览显示替换：把 content 里的 `@username` token 换成 `@displayName`（只换显示，不换存储/复核）。
// 与前端 mention-text.ts 的 splitMentionSegments 同口径：逐 @ 扫描 + isMentionBoundary 词边界，
// username 最长优先（`@core:1` 是 `@core:12` 的前缀）。mentions 形如 { username, displayName }。
export function replaceMentionTokens(content, mentions) {
	const text = String(content || "");
	const candidates = (Array.isArray(mentions) ? mentions : [])
		.map((mention) => ({
			username: String(mention?.username || ""),
			displayName: String(mention?.displayName ?? mention?.display_name ?? ""),
		}))
		.filter((mention) => mention.username && mention.displayName);
	if (candidates.length === 0) return text;
	const sorted = [...candidates].sort((a, b) => b.username.length - a.username.length);
	let result = "";
	let index = 0;
	while (index < text.length) {
		if (text[index] !== "@") {
			result += text[index];
			index += 1;
			continue;
		}
		let replaced = false;
		for (const candidate of sorted) {
			const token = `@${candidate.username}`;
			const end = index + token.length;
			if (end > text.length) continue;
			if (text.slice(index, end).toLowerCase() !== token.toLowerCase()) continue;
			if (index > 0 && !isMentionBoundary(text[index - 1])) continue;
			if (end < text.length && !isMentionBoundary(text[end])) continue;
			result += `@${candidate.displayName}`;
			index = end;
			replaced = true;
			break;
		}
		if (!replaced) {
			result += text[index];
			index += 1;
		}
	}
	return result;
}

export async function resolveMessageMentionUserIds(db, {
	channelId,
	roomKind,
	senderId,
	content,
	candidateUserIds,
}) {
	// 允许 @ 自己（#347 口径定案）：不剔除发送者，chip 插入的 @自己 与他人同样复核入列。
	const candidates = normalizeMentionUserIds(candidateUserIds);
	if (roomKind === "dm" || candidates.length === 0) {
		return [];
	}

	const placeholders = candidates.map(() => "?").join(", ");
	const { results } = await db
		.prepare(
			`SELECT cm.user_id, u.username
			 FROM channel_members cm
			 JOIN users u ON u.id = cm.user_id
			 WHERE cm.channel_id = ?
			   AND cm.user_id IN (${placeholders})
			   AND u.deleted_at IS NULL
			   AND ${activeUserSql("u")}`,
		)
		.bind(Number(channelId), ...candidates)
		.all();

	return results
		.filter(
			(row) =>
				row.username !== MENTION_ALL_NAME &&
				contentMentionsUsername(content, row.username),
		)
		.map((row) => Number(row.user_id));
}
