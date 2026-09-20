// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/api/user-blocks.ts（GPL-3.0-only，裁剪版）
import type { Hono } from "hono";
import { getUserBlockStatus, setUserBlocked } from "../data/user-blocks.ts";
import { errorResponse } from "../utils.js";

function targetUserId(c: { req: { param(name: string): string } }): number {
	return Number(c.req.param("userId"));
}

export function registerUserBlockRoutes(app: Hono) {
	app.put("/api/users/:userId/block", async (c) => {
		const session = c.get("session");
		const userId = targetUserId(c);
		if (!Number.isInteger(userId) || userId < 1 || userId === session.userId) {
			return errorResponse("请选择有效用户");
		}

		const status = await getUserBlockStatus(c.env.DB, session.userId, userId);
		if (!status.targetExists) {
			return errorResponse("目标用户不存在", 404);
		}
		await setUserBlocked(c.env.DB, session.userId, userId, true);
		return c.json({ blockedByMe: true });
	});

	app.delete("/api/users/:userId/block", async (c) => {
		const session = c.get("session");
		const userId = targetUserId(c);
		if (!Number.isInteger(userId) || userId < 1 || userId === session.userId) {
			return errorResponse("请选择有效用户");
		}

		const status = await getUserBlockStatus(c.env.DB, session.userId, userId);
		if (!status.targetExists) {
			return errorResponse("目标用户不存在", 404);
		}
		await setUserBlocked(c.env.DB, session.userId, userId, false);
		return c.json({ blockedByMe: false });
	});
}
