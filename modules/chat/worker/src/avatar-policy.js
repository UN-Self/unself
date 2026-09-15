// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/avatar-policy.js（GPL-3.0-only，裁剪版）
import {
	getOwnedUploadedFileMetadata,
	isR2ObjectUnavailableError,
} from "./data/uploaded-files.js";
import { ApiError } from "./errors.js";

export { isR2ObjectUnavailableError };

export async function resolveAvatarKeyUpdate(db, userId, payload) {
	if (!Object.hasOwn(payload, "avatarKey")) {
		return { provided: false, key: null };
	}

	const key = String(payload.avatarKey || "").trim();
	if (!key) {
		return { provided: true, key: null };
	}

	const file = await getOwnedUploadedFileMetadata(db, key, userId);
	if (!file) {
		throw new ApiError("头像只能使用当前账号上传的图片");
	}
	if (!String(file.contentType || "").startsWith("image/")) {
		throw new ApiError("头像文件必须是图片");
	}

	return { provided: true, key };
}
