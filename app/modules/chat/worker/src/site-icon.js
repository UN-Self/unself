// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/site-icon.js（GPL-3.0-only，裁剪版）
const R2_SITE_ICON_PREFIX = "r2:";

function decodeFilePath(pathname) {
	if (!String(pathname || "").startsWith("/files/")) return null;
	const encodedKey = String(pathname).slice("/files/".length);
	if (!encodedKey) return null;
	try {
		return decodeURIComponent(encodedKey);
	} catch {
		return null;
	}
}

function absoluteHttpUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

function normalizedOrigins(origins) {
	return new Set(
		origins
			.map((origin) => absoluteHttpUrl(String(origin || "").trim())?.origin)
			.filter(Boolean),
	);
}

export function siteIconUrlFromStored(value) {
	const stored = String(value || "").trim();
	if (!stored.startsWith(R2_SITE_ICON_PREFIX)) return stored;
	const key = stored.slice(R2_SITE_ICON_PREFIX.length);
	return key ? `/files/${encodeURIComponent(key)}` : "";
}

export function normalizeSiteIconForStorage(value, trustedOrigins = []) {
	const raw = String(value || "").trim();
	if (!raw) return "";
	if (raw.startsWith(R2_SITE_ICON_PREFIX)) return raw;

	if (raw.startsWith("/files/")) {
		const key = decodeFilePath(new URL(raw, "https://edgechat.invalid").pathname);
		return key ? `${R2_SITE_ICON_PREFIX}${key}` : raw;
	}

	const absolute = absoluteHttpUrl(raw);
	if (absolute) {
		const key = decodeFilePath(absolute.pathname);
		if (key && normalizedOrigins(trustedOrigins).has(absolute.origin)) {
			return `${R2_SITE_ICON_PREFIX}${key}`;
		}
		return raw;
	}

	// 历史版本允许直接保存 object key；非 / 开头的相对值继续按该兼容语义处理。
	return raw.startsWith("/") ? raw : `${R2_SITE_ICON_PREFIX}${raw}`;
}

export function classifyStoredSiteIcon(value, trustedOrigins = []) {
	const stored = String(value || "").trim();
	if (!stored) return { kind: "none", key: null };
	if (stored.startsWith(R2_SITE_ICON_PREFIX)) {
		return { kind: "local", key: stored.slice(R2_SITE_ICON_PREFIX.length) || null };
	}
	if (stored.startsWith("/files/")) {
		return {
			kind: "local",
			key: decodeFilePath(new URL(stored, "https://edgechat.invalid").pathname),
		};
	}

	const absolute = absoluteHttpUrl(stored);
	if (absolute) {
		const key = decodeFilePath(absolute.pathname);
		if (!key) return { kind: "external", key: null };
		const origins = normalizedOrigins(trustedOrigins);
		if (origins.size > 0 && !origins.has(absolute.origin)) {
			return { kind: "external", key: null };
		}
		return {
			kind: origins.has(absolute.origin) ? "local" : "ambiguous",
			key,
		};
	}

	return stored.startsWith("/")
		? { kind: "external", key: null }
		: { kind: "local", key: stored };
}
