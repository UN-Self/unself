// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/api/maintenance.ts（GPL-3.0-only，裁剪版）
import type { Hono } from 'hono';
import { runSystemCheck } from '../maintenance/system-check.ts';

export function registerMaintenanceRoutes(app: Hono) {
  app.get('/api/admin/maintenance', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(await runSystemCheck(c.env));
  });
}
