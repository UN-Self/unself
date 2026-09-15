// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/verified-identity.js（GPL-3.0-only，裁剪版）
const INTERNAL_AUTH_HEADER = "x-cfchat-internal-auth";
const VERIFIED_USER_ID_HEADER = "x-cfchat-verified-user-id";
const VERIFIED_IS_ADMIN_HEADER = "x-cfchat-verified-is-admin";
const VERIFIED_AT_HEADER = "x-cfchat-verified-at";
const INTERNAL_AUTH_VALUE = "worker-verified";

export function isVerifiedInternalRequest(request) {
	return request.headers.get(INTERNAL_AUTH_HEADER) === INTERNAL_AUTH_VALUE;
}

export function createInternalHeaders(sourceHeaders = undefined) {
	const headers = new Headers(sourceHeaders);
	headers.set(INTERNAL_AUTH_HEADER, INTERNAL_AUTH_VALUE);
	return headers;
}

export function createVerifiedPrincipalHeaders(sourceHeaders, principal) {
	const headers = createInternalHeaders(sourceHeaders);
	headers.set(VERIFIED_USER_ID_HEADER, String(principal.userId));
	headers.set(VERIFIED_IS_ADMIN_HEADER, principal.isAdmin ? "1" : "0");
	headers.set(VERIFIED_AT_HEADER, String(Date.now()));
	return headers;
}

export function parseVerifiedPrincipal(request) {
	if (!isVerifiedInternalRequest(request)) {
		return null;
	}

	const rawUserId = request.headers.get(VERIFIED_USER_ID_HEADER);
	const rawVerifiedAt = request.headers.get(VERIFIED_AT_HEADER);
	const userId = Number(rawUserId);
	const verifiedAt = Number(rawVerifiedAt);
	if (
		!rawUserId ||
		!rawVerifiedAt ||
		!Number.isFinite(userId) ||
		userId <= 0 ||
		!Number.isFinite(verifiedAt) ||
		verifiedAt <= 0
	) {
		return null;
	}

	return {
		userId,
		isAdmin: request.headers.get(VERIFIED_IS_ADMIN_HEADER) === "1",
	};
}

export function parseVerifiedUserId(request) {
	return parseVerifiedPrincipal(request)?.userId ?? null;
}
