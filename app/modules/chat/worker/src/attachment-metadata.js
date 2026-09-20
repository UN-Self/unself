// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/attachment-metadata.js（GPL-3.0-only，裁剪版）
export function normalizeContentType(value) {
	return String(value || "")
		.split(";")[0]
		.trim()
		.toLowerCase();
}

export function sanitizeFilename(value, fallback = "file") {
	const cleaned = Array.from(
		String(value || "")
			.trim()
			.replaceAll("/", "_")
			.replaceAll("\\", "_"),
	)
		.filter((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint === undefined || (codePoint >= 0x20 && codePoint !== 0x7f);
		})
		.join("");
	return cleaned.slice(0, 180) || fallback;
}

export function safeFilenameExtension(filename) {
	const cleanName = sanitizeFilename(filename);
	const dotIndex = cleanName.lastIndexOf(".");
	if (dotIndex <= 0) return "";
	const extension = cleanName.slice(dotIndex + 1).toLowerCase();
	return /^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : "";
}

const MAX_VOICE_DURATION_MS = 4 * 60 * 60 * 1000;
const MAX_VOICE_WAVEFORM_SAMPLES = 64;

export function normalizeAudioAttachmentMetadata(payload, contentType) {
	const kind = payload?.kind === "voice" || payload?.kind === "audio" ? payload.kind : null;
	if (!kind || !normalizeContentType(contentType).startsWith("audio/")) {
		return {};
	}

	const durationMs = Math.min(
		Math.max(Math.round(Number(payload.durationMs) || 0), 0),
		MAX_VOICE_DURATION_MS,
	);
	const waveform = kind === "voice" && Array.isArray(payload.waveform)
		? payload.waveform
			.slice(0, MAX_VOICE_WAVEFORM_SAMPLES)
			.map((sample) => Math.min(Math.max(Math.round(Number(sample) || 0), 0), 100))
		: [];
	return { kind, durationMs, ...(kind === "voice" ? { waveform } : {}) };
}
