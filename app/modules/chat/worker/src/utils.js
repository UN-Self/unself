// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/utils.js（GPL-3.0-only，裁剪版）
import { normalizeAudioAttachmentMetadata } from "./attachment-metadata.js";

export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {})
    }
  });
}

export function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, { status });
}

export function v1ErrorResponse(code, message, status = 400) {
  return jsonResponse({ error: { code, message } }, { status });
}

export function errorCodeForStatus(status) {
  if (status === 401) return 'authentication_required';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 413) return 'payload_too_large';
  if (status === 503) return 'service_unavailable';
  if (status >= 500) return 'internal_error';
  return 'invalid_request';
}

export const MAX_JSON_BODY_SIZE = 10 * 1024 * 1024;

export function requestBodyTooLarge(request, maxBytes = MAX_JSON_BODY_SIZE) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  return Number.isFinite(contentLength) && contentLength > maxBytes;
}

export function parseJsonRequest(request) {
  return request.json().catch(() => ({}));
}

export function sanitizeLimit(value, fallback = 30, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function keyBelongsToOwner(key, ownerUserId) {
  if (ownerUserId === undefined || ownerUserId === null) {
    return true;
  }

  const ownerPrefix = `${Number(ownerUserId)}/`;
  return Number.isFinite(Number(ownerUserId)) && String(key || '').startsWith(ownerPrefix);
}

export function pickAttachment(payload, options = {}) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (!payload.key || !payload.name || !payload.type) {
    return null;
  }

  const key = String(payload.key);
  if (!keyBelongsToOwner(key, options.ownerUserId)) {
    return null;
  }

	const type = String(payload.type);
	return {
		key,
		name: String(payload.name),
		type,
		size: Number(payload.size) || 0,
		url: `/files/${encodeURIComponent(key)}`,
		...normalizeAudioAttachmentMetadata(payload, type),
	};
}

export function publicFileUrl(key) {
  return `/files/${encodeURIComponent(key)}`;
}

export function nextDailyUtcHour(hour) {
  const target = new Date();
  target.setUTCMinutes(0, 0, 0);
  target.setUTCHours(hour);
  if (target <= new Date()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target;
}

export function randomToken(byteLength = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
