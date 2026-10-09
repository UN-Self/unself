// SPDX-License-Identifier: AGPL-3.0-only
import type { Hono } from 'hono';

import type { Bindings, CoreApiDependencies } from '../index';
import type { SessionGuardVariables } from '../middleware/session-guard';
import { readMailAccess } from '../services/members';
import { getProfileIdentity, updateDisplayName } from '../services/users';

import { profileAvatarUrl } from '../services/avatar-store';
import { avatarStore } from '../adapters/avatar-store';

/** 当前成员资料的 Core 读写入口；会话与成员状态由组合根守卫验证。 */
export function registerProfileRoutes(app: Hono<{ Bindings: Bindings; Variables: SessionGuardVariables }>, dependencies: CoreApiDependencies): void {
  app.get('/api/me', async (c) => {
    const session = c.get('session');
    const member = c.get('member');
    const profile = await getProfileIdentity(c.env.CORE_DB, session.uid);
    const mail = await readMailAccess(c.env.CORE_DB);
    return c.json({
      authenticated: true,
      user: { id: session.uid, name: profile?.name ?? session.name, issuer: session.iss, sub: session.sub, role: member.role, avatarUrl: profileAvatarUrl(c.req.url, profile?.avatarKey) },
      avatarUploadEnabled: Boolean(avatarStore(c.env, dependencies)),
      mailEnabled: mail.enabled,
      mailPortalUrl: mail.portalUrl,
    });
  });

  app.patch('/api/me', async (c) => {
    const body = await c.req.json().catch(() => null) as { name?: unknown } | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) return c.json({ error: '昵称需为 1-80 个字符' }, 400);
    const session = c.get('session');
    if (!await updateDisplayName(c.env.CORE_DB, session.uid, name)) return c.json({ error: '用户不可用' }, 404);
    return c.json({ name });
  });
}
