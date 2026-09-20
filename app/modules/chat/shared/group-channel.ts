// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d shared/group-channel.ts（GPL-3.0-only，裁剪版）
export const GROUP_CHANNEL_KINDS = ["public", "private"] as const;

export type GroupChannelKind = (typeof GROUP_CHANNEL_KINDS)[number];

export function isGroupChannelKind(kind: unknown): kind is GroupChannelKind {
	return kind === "public" || kind === "private";
}
