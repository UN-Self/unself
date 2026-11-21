// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/api/dm.js（GPL-3.0-only，裁剪版）
import { userAvatarUrl } from '../profile-avatar.js';
import { ensureDmChannel } from '../data/dm-provisioning.js';
import { listAdminDms, listUserDms } from '../data/dm-queries.js';
import { projectIdentity } from '../data/users.js';
import { getUserBlockStatus } from '../data/user-blocks.ts';
import { errorResponse, parseJsonRequest } from '../utils.js';
import { activeUserSql } from '../user-status.js';

export function registerDmRoutes(app) {
  app.get('/api/dm', async (c) => {
    const session = c.get('session');
    const dms = await listUserDms(c.env.DB, session.userId, c.env);
    return c.json({ dms });
  });

  app.post('/api/dm/open', async (c) => {
    const session = c.get('session');
    const payload = await parseJsonRequest(c.req.raw);
    const targetUserId = Number(payload.userId);

    if (!Number.isFinite(targetUserId) || targetUserId === session.userId) {
      return errorResponse('请选择有效用户');
    }

    const targetUser = await c.env.DB.prepare(
      `SELECT id, username, display_name, core_avatar_url, avatar_key, core_login_name, core_identity_source, core_email
       FROM users
       WHERE id = ?
         AND ${activeUserSql()}
         AND deleted_at IS NULL
       LIMIT 1`
    )
      .bind(targetUserId)
      .all();

    if (!targetUser.results[0]) {
      return errorResponse('目标用户不存在', 404);
    }

    const target = targetUser.results[0];
    const [channel, blockStatus] = await Promise.all([
      ensureDmChannel(c.env.DB, session.userId, targetUserId),
      getUserBlockStatus(c.env.DB, session.userId, targetUserId)
    ]);
    return c.json({
      dm: {
        id: Number(channel.id),
        kind: 'dm',
        name: channel.dm_key,
        otherUser: {
          id: Number(target.id),
          username: target.username,
          displayName: target.display_name,
          avatarUrl: userAvatarUrl(target.core_avatar_url, target.avatar_key),
          // #透传：与 GET /api/dm 同一条投影规则，私聊资料卡才有邮箱可显示
          ...projectIdentity(target)
        },
        isBlockedByMe: blockStatus.blockedByMe
      }
    });
  });

  app.get('/api/admin/dms', async (c) => {
    const dms = await listAdminDms(c.env.DB);
    return c.json({ dms });
  });
}
