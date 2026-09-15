// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d shared/user-profile.ts（GPL-3.0-only，裁剪版）
export const BIO_MAX_LENGTH = 200;

export type UserSummary = {
	id: number;
	username: string;
	displayName: string;
	avatarUrl: string;
};

export type UserProfile = UserSummary & { bio: string };

export type ProfileIdentity =
	| ({ kind: "local" } & UserSummary)
	| {
			kind: "external";
			source: string;
			id: string;
			displayName: string;
			avatarUrl: string;
	  };

export function normalizeBio(value: string): string {
	return value.replace(/\r\n?/g, "\n").trim();
}

export function bioLength(value: string): number {
	return Array.from(normalizeBio(value)).length;
}

export function validateBio(value: unknown): string {
	if (typeof value !== "string") throw new Error("个人简介必须是文本");
	const bio = normalizeBio(value);
	if (bioLength(bio) > BIO_MAX_LENGTH) throw new Error("个人简介不能超过 200 个字符");
	return bio;
}

export function parseLocalUserId(value: string | number): number | null {
	if (!/^[1-9]\d*$/.test(String(value))) return null;
	const id = Number(value);
	return Number.isSafeInteger(id) ? id : null;
}
