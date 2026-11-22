// SPDX-License-Identifier: GPL-3.0-only

/**
 * 消息转发（#347）：客户端只传 forwardFromMessageIds，服务端读取源消息并复制落地——
 * 不接受客户端自带内容（防伪造），附件沿用原 R2 key（归属按 uploaded_files 真实 owner 校验——
 * 副本不记原发件人，转发方对源消息的可读性在此统一校验）。两种模式：
 * - single 逐条：每条源消息复制为一条普通消息（不标注来源，外观与普通消息一致）；
 * - merged 合并：全部源消息序列化为 forward_bundle blocks（存 message_block_payloads
 *   content_blocks，0005 已有的加密 JSON 扩展点，不动 messages 表结构），正文存摘要文案。
 */
import { getMessagesByIds, insertForwardMessagesAtomic } from "./data/messages.js";
import { authorizeRoom } from "./room-access.js";
import { replaceMentionTokens } from "./data/mentions.js";
import { getDirectMessageBlockStatus } from "./data/user-blocks.ts";
import { dmBlockRejectionOf } from "./dm-blocks.js";

export class ForwardSubmissionError extends Error {
	constructor(message, code = "forward_source_unavailable", status = 400) {
		super(message);
		this.name = "ForwardSubmissionError";
		this.code = code;
		this.status = status;
	}
}

const MAX_FORWARD_MESSAGES = 50;

/**
 * 合并转发 bundle 序列化后的大小上限（字符）。D1 单条 SQL 语句上限 100KB；bundle JSON
 * 落地前还要整体加密（密文 base64，中文 UTF-8 3 字节/字符再膨胀 ~1.37x），超过它会以
 * 裸错误 500。60k 字符留足余量，超限给人话 400。
 */
const MAX_FORWARD_BUNDLE_JSON = 60_000;

/** 源消息读取 + 可读性校验：每条源消息所在房间都必须是转发者当前可读的房间。 */
async function resolveForwardSources(env, principal, messageIds) {
	const normalized = [];
	for (const rawId of messageIds) {
		const messageId = Number(rawId);
		if (!Number.isInteger(messageId) || messageId <= 0) {
			throw new ForwardSubmissionError("转发参数无效", "invalid_request");
		}
		normalized.push(messageId);
	}
	// 展示与落地按源消息 id 升序（旧→新），客户端勾选顺序不可靠；重复 id 各自保留一条副本
	normalized.sort((left, right) => left - right);
	// 批量回读（M2）：一次查询替代逐条 getMessageById 的 N 次往返；getMessagesByIds
	// 按 id 精确匹配且过滤 deleted_at，缺失（含已删除）统一按「不存在或已被删除」拒绝
	const unique = [...new Set(normalized)];
	const fetched = await getMessagesByIds(env, unique);
	const byId = new Map();
	for (let index = 0; index < unique.length; index++) byId.set(unique[index], fetched[index] ?? null);
	const sources = normalized.map((id) => byId.get(id) ?? null);
	if (sources.some((message) => !message)) {
		throw new ForwardSubmissionError("转发的消息不存在或已被删除");
	}
	for (const message of sources) {
		if (message.sender.kind !== "local") {
			// 外部桥消息（sender.kind === 'external'）不复制落地，与本地消息区分开给准确文案
			throw new ForwardSubmissionError("外部桥接的消息暂不支持转发", "forward_source_unsupported", 400);
		}
	}
	// getMessageById 不限房间：这里按消息所属房间补授权校验（一次查询取全房间，同房间只验一次）
	const placeholders = unique.map(() => "?").join(", ");
	const { results } = await env.DB
		.prepare(`SELECT m.id, c.id AS channel_id, c.kind FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id IN (${placeholders})`)
		.bind(...unique)
		.all();
	const roomsById = new Map();
	for (const row of results) roomsById.set(Number(row.id), { id: Number(row.channel_id), kind: row.kind });
	const authorizedRooms = new Map();
	for (const message of sources) {
		const sourceRoom = roomsById.get(message.id);
		if (!sourceRoom) throw new ForwardSubmissionError("转发的消息不存在或已被删除");
		const roomKey = `${sourceRoom.kind}:${sourceRoom.id}`;
		if (!authorizedRooms.has(roomKey)) {
			const access = await authorizeRoom(env.DB, principal, sourceRoom.kind, sourceRoom.id);
			if (!access.ok) throw new ForwardSubmissionError("无权转发该消息");
			authorizedRooms.set(roomKey, access.room);
		}
	}
	return sources;
}

/**
 * 附件批量校验 + 真实 owner 回读（subrequest 收敛）：一次 IN 查询取全部附件 key 的
 * uploaded_files 登记与 owner。不与「消息 sender」比对——副本消息不记原发件人，二转时
 * 必然断链（线上 400「转发的消息包含不可用附件」即此）；访问控制由「源房间可读」保证
 * （resolveForwardSources）。返回 Map<key, 真实 owner_id>，落地项用它做 attachmentOwner：
 * keyBelongsToOwner 的 key 前缀检查、normalizeMessageBlocks 的 getOwnedUploadedFileMetadata
 * 都按真实 owner 通过，转发多少手都不断链。同时跳过逐条 fileBelongsToUser（N 条带附件的
 * 转发 = N 个 subrequest，免费版 50 上限会在十几条就爆成 500）。
 */
async function resolveAttachmentOwners(env, sources) {
	const keys = new Set();
	for (const message of sources) {
		if (message.attachment?.key) keys.add(String(message.attachment.key));
		// blocks 内嵌附件（图文混排，无顶层 attachment）一并确认，与落地口径一致
		for (const block of Array.isArray(message.blocks) ? message.blocks : []) {
			if (block?.type === "attachment" && block.attachment?.key) keys.add(String(block.attachment.key));
		}
	}
	const owners = new Map();
	if (!keys.size) return owners;
	const unique = [...keys];
	const placeholders = unique.map(() => "?").join(", ");
	const { results } = await env.DB
		.prepare(`SELECT object_key, owner_user_id FROM uploaded_files WHERE object_key IN (${placeholders})`)
		.bind(...unique)
		.all();
	for (const row of results) owners.set(String(row.object_key), Number(row.owner_user_id));
	for (const key of unique) {
		if (!owners.has(key)) {
			throw new ForwardSubmissionError("转发的消息包含不可用附件", "invalid_request");
		}
	}
	return owners;
}

/** 单条消息的真实附件 owner（同一条消息的附件都是同一上传者，取首个 key 的 owner）。 */
function attachmentOwnerOf(message, owners) {
	const key = message.attachment?.key
		?? (Array.isArray(message.blocks) ? message.blocks.find((block) => block?.type === "attachment")?.attachment?.key : undefined);
	return key ? owners.get(String(key)) ?? null : null;
}

/** 落地前的 DM 目标拦截：被对方拉黑/已拉黑对方时逐条与合并都不发送（与普通发送同语义）。 */
async function requireDmSendable(env, room, senderId) {
	if (room.kind !== "dm") return;
	const blockStatus = await getDirectMessageBlockStatus(env.DB, Number(room.id), Number(senderId));
	const rejection = dmBlockRejectionOf(blockStatus);
	if (rejection) {
		throw new ForwardSubmissionError(rejection.message, rejection.code, rejection.status);
	}
}

/** 转发条目的轻量副本（bundle 内嵌）：内容/附件/发言人名/引用快照（浮层展示用），不带回执。 */
function bundleEntryOf(message) {
	return {
		content: displayContentOf(message),
		blocks: displayBlocksOf(message),
		attachment: message.attachment ?? null,
		senderName: message.sender?.displayName ?? "",
		createdAt: message.createdAt,
		// 引用快照（合并浮层保持与正常聊天一致：作者行 + 截断原文；原文已删则显示占位）
		reply: replySnapshotOf(message.replyTo),
	};
}

/**
 * @token 重写（#347 反馈②）：转发副本不带 mentions（不点亮高亮、不触发未读红标），必须在
 * 复制时把 `@username` 重写成 `@displayName`，否则对端看到裸 `@core:xxx`。
 * 复用 mentions.js 的 replaceMentionTokens（词边界 + username 最长优先），引用块读路径同实现。
 */
function displayContentOf(message) {
	return replaceMentionTokens(message.content, message.mentions);
}

/** blocks 文本段同样重写（图文消息正文在 text block 里）。 */
function displayBlocksOf(message) {
	if (!Array.isArray(message.blocks)) return null;
	return message.blocks.map((block) =>
		block.type === "text" ? { type: "text", text: displayContentOf({ content: block.text, mentions: message.mentions }) } : block,
	);
}

/** 引用快照：作者名 + 截断原文（纯附件引用回退附件名，前端 reply-preview 同口径）；已删回占位。 */
function replySnapshotOf(replyTo) {
	if (!replyTo) return null;
	if (replyTo.deleted) return { deleted: true, authorName: "", text: "" };
	return {
		deleted: false,
		authorName: replyTo.sender?.displayName ?? "",
		text: replyTo.content || (replyTo.attachment ? replyTo.attachment.name : ""),
	};
}

/** 消息本身是否「合并转发」（blocks 里带 forward_bundle）——转发它时保留 bundle，支持套娃。 */
function isBundleMessage(message) {
	return Array.isArray(message.blocks) && message.blocks.some((block) => block?.type === "forward_bundle");
}

/**
 * 递归收集 blocks（含嵌套 forward_bundle 的 messages[].blocks）里的全部附件 key。
 * 合并转发落地时把它们一并登记进 message_attachments，让 canAccessFile 与 GC 都能跨房间看到引用。
 */
function collectAttachmentKeys(blocks) {
	const keys = [];
	const walk = (list) => {
		for (const block of list || []) {
			if (!block) continue;
			if (block.type === "attachment" && block.attachment?.key) keys.push(block.attachment.key);
			else if (block.type === "forward_bundle" && Array.isArray(block.messages)) {
				for (const entry of block.messages) {
					// 条目级附件必须收集：语音/图片/文件消息走顶层 attachment（无 blocks），
					// 只挂在 entry.attachment 上——漏收则副本在 message_attachments 无引用，
					// 目标房间的接收人访问附件会被 canAccessFile 判 Forbidden
					if (entry?.attachment?.key) keys.push(entry.attachment.key);
					walk(entry.blocks);
				}
			}
		}
	};
	walk(blocks);
	return [...new Set(keys)];
}

/**
 * 嵌套 bundle 条目（forward_bundle 的 messages[].attachment / blocks）的附件 key 不在
 * resolveAttachmentOwners 的顶层收集范围内：缺失 uploaded_files 登记时消息会照常落地，
 * 接收人点开摘要卡访问附件才失败。合并落地 / bundle 套娃落地前按 owners Map 提前拦截，
 * 统一给人话 400。
 */
function assertBundleAttachmentsRegistered(blocks, owners) {
	for (const key of collectAttachmentKeys(blocks)) {
		if (!owners.has(String(key))) {
			throw new ForwardSubmissionError("转发的消息包含不可用附件", "invalid_request");
		}
	}
}

/**
 * 提交转发：meta = { principal, room }（目标房间），forward = { mode, messageIds }。
 * 返回最后一条落地消息（HTTP 回包用；全部消息经广播帧下发）。
 */
export async function submitForwardMessage(env, meta, { mode, messageIds, clientMessageId }) {
	if (mode !== "single" && mode !== "merged") {
		throw new ForwardSubmissionError("转发模式无效", "invalid_request");
	}
	if (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.length > MAX_FORWARD_MESSAGES) {
		throw new ForwardSubmissionError(`一次最多转发 ${MAX_FORWARD_MESSAGES} 条消息`, "invalid_request");
	}
	// #347：幂等键必须透传。缺了它逐条转发的派生键会退化成固定 '-1'，第二次往同房间转发
	// 命中幂等回显（返回旧消息）而表现为「转发不成功」，服务端直接拒绝而不是静默出错。
	const normalizedClientMessageId = String(clientMessageId ?? "").trim();
	if (!normalizedClientMessageId) {
		throw new ForwardSubmissionError("转发缺少幂等键", "invalid_request");
	}
	const sources = await resolveForwardSources(env, meta.principal, messageIds);
	await requireDmSendable(env, meta.room, meta.principal.userId);
	// 附件真实 owner 批量回读（subrequest 收敛）：落地项用它做 attachmentOwner，转发多少手都不断链
	const attachmentOwners = await resolveAttachmentOwners(env, sources);

	const forwarderId = Number(meta.principal.userId);
	if (mode === "merged") {
		const bundle = sources.map(bundleEntryOf);
		const count = bundle.length;
		const forwardBlock = { type: "forward_bundle", count, messages: bundle };
		// 大小防护：超限落地会撞 D1 语句长度上限以 500 暴露，落地前给人话 400
		if (JSON.stringify(forwardBlock).length > MAX_FORWARD_BUNDLE_JSON) {
			throw new ForwardSubmissionError(
				"合并转发的聊天记录过大，请减少条数或改用逐条转发",
				"forward_bundle_too_large",
				400,
			);
		}
		// 落地前拦截嵌套 bundle 条目的附件缺登记（见 assertBundleAttachmentsRegistered 注释）
		assertBundleAttachmentsRegistered([forwardBlock], attachmentOwners);
		const { messages, createdFlags } = await insertForwardMessagesAtomic(env, [{
			channelId: meta.room.id,
			senderId: forwarderId,
			// source='forward'：DB 触发器据此豁免「owner = sender / 不在 pending_r2_delete」（0009），
			// 也让撤回/审计能识别转发副本（外观上仍不标注，见 flows.md）
			source: "forward",
			trustAttachmentOwnership: true,
			content: `[聊天记录] ${count} 条消息`,
			// forward_bundle 是服务端内部载荷：rawBlocks 绕过 normalize（只认 text/attachment）
			rawBlocks: [forwardBlock],
			// 内嵌附件（含嵌套）一并登记，做到跨房间可读 + GC 不误删
			attachmentKeysOverride: collectAttachmentKeys([forwardBlock]),
			clientMessageId: normalizedClientMessageId,
		}]);
		const last = messages[messages.length - 1] ?? null;
		// 幂等回显（H1）：created=false 表示此前已落地过，不再广播（原始请求已广播过这一帧）
		const created = createdFlags[0] === true;
		return {
			created,
			message: last,
			messages: created ? [last] : [],
			packets: created ? [JSON.stringify({ protocolVersion: 1, type: "message", message: last })] : [],
		};
	}

	// 逐条：全部源消息在同一个 batch 内原子落地（D1 batch 是 SQL 事务，任一条失败整体回滚）。
	// 普通消息复制为普通消息；源本身是合并转发时保留 bundle（套娃），幂等键按序派生。
	const items = sources.map((source, index) => {
		const base = {
			channelId: meta.room.id,
			senderId: forwarderId,
			source: "forward",
			// 归属已在 resolveAttachmentOwners 一次校验过，落地跳过逐条查询
			trustAttachmentOwnership: true,
			clientMessageId: `${normalizedClientMessageId}-${index + 1}`,
		};
		if (isBundleMessage(source)) {
			// 套娃落地前拦截嵌套附件缺登记（见 assertBundleAttachmentsRegistered 注释）
			assertBundleAttachmentsRegistered(source.blocks, attachmentOwners);
			return {
				...base,
				content: String(source.content ?? ""),
				rawBlocks: source.blocks,
				attachmentKeysOverride: collectAttachmentKeys(source.blocks),
			};
		}
		return {
			...base,
			content: displayContentOf(source),
			blocks: displayBlocksOf(source),
			attachment: source.attachment ?? null,
			// 用 uploaded_files 的真实 owner（而非源消息 sender——二转时两者不同）：
			// key 前缀检查与 normalizeMessageBlocks 的 owner 查询都按真实 owner 通过
			attachmentOwnerUserId: attachmentOwnerOf(source, attachmentOwners),
		};
	});
	const { messages, createdFlags } = await insertForwardMessagesAtomic(env, items);
	// 幂等回显（H1）：只广播本次新落地的条目；回显条目原始请求已广播过，重发会造成对端重复帧
	const createdMessages = messages.filter((message, index) => createdFlags[index] && message);
	return {
		created: createdFlags.some(Boolean),
		message: messages[messages.length - 1] ?? null,
		messages: createdMessages,
		packets: createdMessages.map((message) => JSON.stringify({ protocolVersion: 1, type: "message", message })),
	};
}
