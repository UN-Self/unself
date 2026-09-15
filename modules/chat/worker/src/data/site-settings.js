// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/data/site-settings.js（GPL-3.0-only，裁剪版）
import { normalizeSiteIconForStorage, siteIconUrlFromStored } from "../site-icon.js";

export async function getSiteSettings(db) {
	const { results } = await db
		.prepare("SELECT setting_key, setting_value FROM site_settings")
		.all();
	const map = Object.fromEntries(
		results.map((row) => [row.setting_key, row.setting_value]),
	);
	return {
		siteName: String(map.site_name || "Edgechat"),
		siteIconUrl: siteIconUrlFromStored(map.site_icon_url),
	};
}

export async function updateSiteSettings(db, { siteName, siteIconUrl, siteOrigin = "" }) {
	const statements = [];
	if (siteName !== undefined) {
		statements.push(
			db
				.prepare(
					`INSERT INTO site_settings (setting_key, setting_value, updated_at)
					 VALUES ('site_name', ?, CURRENT_TIMESTAMP)
					 ON CONFLICT(setting_key) DO UPDATE
					 SET setting_value = excluded.setting_value,
					     updated_at = CURRENT_TIMESTAMP`,
				)
				.bind(String(siteName || "Edgechat").trim() || "Edgechat"),
		);
	}
	if (siteIconUrl !== undefined) {
		const storedIcon = normalizeSiteIconForStorage(siteIconUrl, [siteOrigin]);
		statements.push(
			db
				.prepare(
					`INSERT INTO site_settings (setting_key, setting_value, updated_at)
					 VALUES ('site_icon_url', ?, CURRENT_TIMESTAMP)
					 ON CONFLICT(setting_key) DO UPDATE
					 SET setting_value = excluded.setting_value,
					     updated_at = CURRENT_TIMESTAMP`,
				)
				.bind(storedIcon),
		);
	}
	if (statements.length) {
		await db.batch(statements);
	}
	return getSiteSettings(db);
}
