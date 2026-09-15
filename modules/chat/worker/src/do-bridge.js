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

	const init = {
		method: request.method,
		headers: createVerifiedPrincipalHeaders(request.headers, principal),
	};
	if (!["GET", "HEAD"].includes(request.method)) {
		// 先把请求体固化为可重放字节，避免跨运行时转发 ReadableStream 时依赖 Node 专属 duplex 配置。
		init.body = await request.arrayBuffer();
	}
	return stub.fetch(new Request(url.toString(), init));
}

export function forwardRoomConnection({ env, request, kind, roomId, principal }) {
	return forwardVerifiedRequest({
		stub: getChannelRoomStub(env, kind, roomId),
		request,
		pathname: "/connect",
		searchParams: { kind, id: roomId, token: principal.token },
		principal,
	});
}

export function forwardInboxConnection({ env, request, principal }) {
	return forwardVerifiedRequest({
		stub: getUserInboxStub(env, principal.userId),
		request,
		pathname: "/connect",
		principal,
	});
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
