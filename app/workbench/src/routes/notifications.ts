// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 通知中心读侧 HTTP（#19）：只挂用户侧读取与已读回执。
 *
 * 投递（deliverNotification）是服务端内部触发口径（邀请审批 / 账号开通 / 模块启停），
 * 不暴露 HTTP——触发点由各业务域自行调用，避免把通知变成可被外部滥用的写接口。
 * 会话真值只信服务端（readSession）；无会话一律 401，与他人无关的通知一律 404。
 */
import { Hono } from 'hono';

import {
  countUnreadNotifications,
  listNotifications,
  markNotificationRead,
} from '../services/notifications';
import { readSession } from '../session';
import type { Bindings } from '../index';

/** 挂载通知域（/api/notifications*）。 */
export function registerNotificationRoutes(app: Hono<{ Bindings: Bindings }>): void {
  /** 当前用户通知列表（新→旧，最多 100 条，不分页）。 */
  app.get('/api/notifications', async (c) => {
    const session = await readSession(c);
    if (!session) {
      return c.json({ error: 'authentication required' }, 401);
    }
    return c.json(await listNotifications(c.env.CORE_DB, session.uid));
  });

  /** 未读徽章数据源。 */
  app.get('/api/notifications/unread-count', async (c) => {
    const session = await readSession(c);
    if (!session) {
      return c.json({ error: 'authentication required' }, 401);
    }
    return c.json({ count: await countUnreadNotifications(c.env.CORE_DB, session.uid) });
  });

  /** 标记自己的通知已读；他人 id 与不存在同样回 404（不泄露存在性）。 */
  app.post('/api/notifications/:id/read', async (c) => {
    const session = await readSession(c);
    if (!session) {
      return c.json({ error: 'authentication required' }, 401);
    }
    const marked = await markNotificationRead(c.env.CORE_DB, session.uid, c.req.param('id'));
    if (!marked) {
      return c.json({ error: 'notification not found' }, 404);
    }
    return c.json({ ok: true });
  });
}
