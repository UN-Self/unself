// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/api/user-profile.ts（GPL-3.0-only，裁剪版）
import type { Hono } from "hono";
import { parseLocalUserId } from "../../../shared/user-profile.ts";
import { getUserProfile } from "../data/users.js";
import { errorResponse } from "../utils.js";

export function registerUserProfileRoutes(app: Hono) {
	app.get("/api/users/:id/profile", async (c) => {
		const id = parseLocalUserId(c.req.param("id"));
		if (id === null) return errorResponse("用户 ID 无效", 400);
		const profile = await getUserProfile(c.env.DB, id);
		if (!profile) return errorResponse("用户资料不可用", 404);
		return c.json({ profile });
	});

	app.patch("/api/me/profile", (c) => {
		return errorResponse("请在工作台修改个人资料", 403);
	});
}
