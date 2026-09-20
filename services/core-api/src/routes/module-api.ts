// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块 Core API（/api/module-api/*，issue #243 决策 #56）：
 *
 * 这是「模块 → 平台」的方向性边界：模块后端（SDK 代理）持模块 token 调用，
 * 权限按注册表 manifest 快照的 permissions 声明放行（未声明 → 403）。
 *
 * 词表六项的落地状态（首版只实现有真实消费者的两个词，其余留 501 占位防静默假成功）：
 * - storage：模块键值存储（module_kv，MODULES_DB）——真实现；**这是 `core` 级数据落点的唯一通道**
 *   （#248 决策 #55/#75 收敛（a)：模块 SDK 不再直连数据库，见 core/sdk/src/storage.ts）；
 * - notify：向成员发站内通知（module_notify 类型行，迁移 0008 种入）——真实现；
 * - acl / ai / realtime / mail：契约预留（词表冻结、门禁生效），端点 501 待后续 issue 接线。
 */
import { Hono } from 'hono';

import type { Bindings } from '../index';
import { moduleApiCors } from '../middleware/module-api-cors';
import { requireModuleAuth, requireModulePermission } from '../middleware/module-auth';
import type { ModuleAuthVariables } from '../token';
import { deliverNotification } from '../services/notifications';

/** 模块键值行（module_kv，平台基建表：services/core-api/migrations/modules/0001_module_kv.sql，#248）。 */
interface KvRow {
  key: string;
  value: string;
}

export function registerModuleApiRoutes(app: Hono<{ Bindings: Bindings; Variables: ModuleAuthVariables }>): void {
  const moduleApi = new Hono<{ Bindings: Bindings; Variables: ModuleAuthVariables }>();

  // CORS（#63/#73）：在 token 门禁之前——预检 OPTIONS 无 Authorization，也必须在门禁前短路回答；
  // 白名单 = 注册表启用模块的 entry origin，现场查库（启停秒级生效）。
  moduleApi.use('*', moduleApiCors());

  // 门禁两段：① 模块 token（验签 + 注册表快照）；② 能力词按端点叠加
  moduleApi.use('*', requireModuleAuth());

  // --- storage（真实现）：module_kv 的模块子域（module_id = token aud） ----------------
  const storage = new Hono<{ Bindings: Bindings; Variables: ModuleAuthVariables }>();
  storage.use('*', requireModulePermission('storage'));

  storage.get('/:key', async (c) => {
    const key = c.req.param('key');
    const row = await c.env.MODULES_DB.prepare(
      'SELECT value FROM module_kv WHERE module_id = ? AND key = ?',
    )
      .bind(c.get('moduleAuth').moduleId, key)
      .first<KvRow>();
    if (!row) {
      return c.json({ error: 'key not found' }, 404);
    }
    return c.json({ key, value: row.value });
  });

  storage.put('/:key', async (c) => {
    const key = c.req.param('key');
    const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
    if (typeof body?.value !== 'string') {
      return c.json({ error: 'body must be { value: string }' }, 400);
    }
    await c.env.MODULES_DB.prepare(
      `INSERT INTO module_kv (module_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(module_id, key) DO UPDATE SET value = excluded.value`,
    )
      .bind(c.get('moduleAuth').moduleId, key, body.value)
      .run();
    return c.json({ ok: true });
  });

  storage.delete('/:key', async (c) => {
    await c.env.MODULES_DB.prepare('DELETE FROM module_kv WHERE module_id = ? AND key = ?')
      .bind(c.get('moduleAuth').moduleId, c.req.param('key'))
      .run();
    return c.json({ ok: true });
  });

  storage.get('/', async (c) => {
    const rows = await c.env.MODULES_DB.prepare(
      'SELECT key FROM module_kv WHERE module_id = ? ORDER BY key',
    )
      .bind(c.get('moduleAuth').moduleId)
      .all<KvRow>();
    return c.json({ keys: rows.results.map((r) => r.key) });
  });

  moduleApi.route('/storage', storage);

  // --- notify（真实现）：module_notify 类型行（迁移 0008）站内投递 --------------------
  const notify = new Hono<{ Bindings: Bindings; Variables: ModuleAuthVariables }>();
  notify.use('*', requireModulePermission('notify'));

  notify.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userId?: unknown; title?: unknown; body?: unknown }
      | null;
    if (typeof body?.userId !== 'string' || typeof body?.title !== 'string' || body.title === '') {
      return c.json({ error: 'body must be { userId: string, title: string, body?: string }' }, 400);
    }
    const result = await deliverNotification(
      c.env.CORE_DB,
      null, // 模块触发通知只站内（模块不直接驱动邮件渠道，弱化实例同可用）
      'module_notify',
      {
        moduleId: c.get('moduleAuth').moduleId,
        title: body.title,
        body: typeof body.body === 'string' ? body.body : '',
      },
      { userId: body.userId },
    );
    // 收件人不存在（未建档/停用）→ 404，不泄露更多存在性信息
    if (!result || result.inApp === 0) {
      return c.json({ error: 'recipient not found' }, 404);
    }
    return c.json({ ok: true }, 201);
  });

  moduleApi.route('/notify', notify);

  // --- acl / ai / realtime / mail（契约预留）：门禁先生效，端点 501 --------------------
  for (const word of ['acl', 'ai', 'realtime', 'mail'] as const) {
    moduleApi.all(
      `/${word}/*`,
      requireModulePermission(word),
      (c) => c.json({ error: `permission '${word}' gate active; api not wired yet (contract v1)` }, 501),
    );
    // 精确根路径也拦（Hono 的 /x/* 不含 /x 本身）
    moduleApi.all(
      `/${word}`,
      requireModulePermission(word),
      (c) => c.json({ error: `permission '${word}' gate active; api not wired yet (contract v1)` }, 501),
    );
  }

  app.route('/api/module-api', moduleApi);
}
