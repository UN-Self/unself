// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/do-bridge.js（GPL-3.0-only，裁剪版）
import {
	createInternalHeaders,
	createVerifiedPrincipalHeaders,
} from "./verified-identity.js";

const INTERNAL_ORIGIN = "https://cfchat.internal";

function getChannelRoomStub(env, kind, roomId) {
	const name = `${kind}:${Number(roomId)}`;
	return env.CHANNEL_ROOM.get(env.CHANNEL_ROOM.idFromName(name));
}

function getUserInboxStub(env, userId) {
	const name = `user:${Number(userId)}`;
	return env.USER_INBOX.get(env.USER_INBOX.idFromName(name));
}

export async function forwardVerifiedRequest({
	stub,
	request,
	pathname,
	searchParams = {},
	principal,
}) {
	const url = new URL(request.url);
	url.pathname = pathname;
	for (const [key, value] of Object.entries(searchParams)) {
		if (value !== undefined && value !== null) {
			url.searchParams.set(key, String(value));
		}
	}

	// 用原请求作为基底重写 URL。Cloudflare 的 WebSocket 升级信息不在普通
	// headers 里，重新用 method/headers/body 组装 Request 会把它丢掉，DO
	// 因而只能看到普通 GET 并返回 426。以原 Request 构造可保留 upgrade 元数据。
	const forwarded = new Request(url.toString(), request);
	const verifiedHeaders = createVerifiedPrincipalHeaders(forwarded.headers, principal);
	for (const [key, value] of verifiedHeaders) {
		forwarded.headers.set(key, value);
	}
	return stub.fetch(forwarded);
}

export function forwardRoomConnection({ env, request, kind, roomId, principal }) {
	// WebSocket upgrade 必须使用浏览器发来的原始 Request。Cloudflare
	// Durable Objects 官方模式是直接 stub.fetch(request)；重建 Request
	// 会丢失运行时的 upgrade 元数据。JWT 已在原始 URL 中，DO 会自行验签。
	return getChannelRoomStub(env, kind, roomId).fetch(request);
}

export function forwardInboxConnection({ env, request, principal }) {
	// 收件箱 DO 不接触 JWT，只信入口 Worker 已验签后注入的用户头。
	// 以原始 Request 为基底重写身份头，保留 WebSocket upgrade 元数据。
	const forwarded = new Request(request.url, request);
	const headers = createVerifiedPrincipalHeaders(forwarded.headers, principal);
	for (const [key, value] of headers) {
		forwarded.headers.set(key, value);
	}
	return getUserInboxStub(env, principal.userId).fetch(forwarded);
}

export async function notifyUserInbox(env, userId, payload) {
	const response = await getUserInboxStub(env, userId).fetch(`${INTERNAL_ORIGIN}/notify`, {
		method: "POST",
		headers: createInternalHeaders({ "Content-Type": "application/json" }),
		body: JSON.stringify(payload),
	});
	return response;
}

export function submitClientRoomAction(env, { room, principal, action }) {
  return forwardVerifiedRequest({
    stub: getChannelRoomStub(env, room.kind, room.id),
    request: new Request(`${INTERNAL_ORIGIN}/client-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, action })
    }),
    pathname: '/client-action',
    principal
  });
}

// #220 已读回执：同 /client-action 形状的 verified internal 转发（DO 是唯一写者：落行+diff+广播）。
export function submitRoomReceipts(env, { room, principal, messageIds }) {
  return forwardVerifiedRequest({
    stub: getChannelRoomStub(env, room.kind, room.id),
    request: new Request(`${INTERNAL_ORIGIN}/receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, messageIds })
    }),
    pathname: '/receipts',
    principal
  });
}

export async function submitExternalRoomMessage(env, payload) {
	const room = payload.room;
	return getChannelRoomStub(env, room.kind, room.id).fetch(
		`${INTERNAL_ORIGIN}/external-message`,
		{
			method: "POST",
			headers: createInternalHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(payload),
		},
	);
}
