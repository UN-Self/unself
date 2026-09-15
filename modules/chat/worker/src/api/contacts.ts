// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/api/contacts.ts（GPL-3.0-only，裁剪版）
import type { Hono } from "hono";
import { listContacts } from "../data/users.js";

export function registerContactRoutes(app: Hono) {
	app.get("/api/contacts", async (c) => {
		const users = await listContacts(c.env.DB);
		return c.json({ users });
	});
}
