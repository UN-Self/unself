// SPDX-License-Identifier: AGPL-3.0-only
import type { Hono } from 'hono';
import type { Bindings, CoreApiDependencies } from '../index';
import type { SessionGuardVariables } from '../middleware/session-guard';
import { avatarStore } from '../adapters/avatar-store';
import { profileAvatarUrl } from '../services/avatar-store';
import { readAvatar } from '../services/avatar-input';
import { getProfileIdentity } from '../services/users';

/** 路由由组合根统一挂成员守卫：上传/删除只操作 session.uid，读取仅限站内成员。 */
export function registerAvatarRoutes(app: Hono<{ Bindings: Bindings; Variables: SessionGuardVariables }>, dependencies: CoreApiDependencies): void {
  app.put('/api/me/avatar', async (c) => {
    const input = await readAvatar(c.req.raw);
    if ('error' in input) return c.json({ error: input.error }, input.status);
    const store = avatarStore(c.env, dependencies);
    if (!store) return c.json({ error: '头像存储尚未配置' }, 503);
    const uid = c.get('session').uid;
    const previous = await getProfileIdentity(c.env.CORE_DB, uid);
    if (!previous) return c.json({ error: '用户不可用' }, 403);
    const key = crypto.randomUUID();
    try { await store.put(key, input.bytes, input.contentType); }
    catch { return c.json({ error: '头像上传失败，请重试' }, 503); }
    let committed = false;
    try {
      const result = await c.env.CORE_DB.prepare(
        'UPDATE users SET avatar_key = ?, profile_revision = profile_revision + 1 WHERE id = ? AND status = ? AND avatar_key IS ?',
      ).bind(key, uid, 'active', previous.avatarKey).run();
      committed = (result.meta.changes ?? 0) > 0;
      if (!committed) return c.json({ error: '资料已在其他窗口更新，请重试' }, 409);
    } catch {
      return c.json({ error: '头像保存失败，请重试' }, 503);
    } finally {
      // 写库失败/并发落败撤销本次对象；成功仅清理旧引用，绝不删除并发请求的新头像。
      const obsolete = committed ? previous.avatarKey : key;
      if (obsolete) await store.delete(obsolete).catch(() => console.warn('profile avatar cleanup failed'));
    }
    return c.json({ avatarUrl: profileAvatarUrl(c.req.url, key) });
  });

  app.delete('/api/me/avatar', async (c) => {
    const uid = c.get('session').uid;
    const previous = await getProfileIdentity(c.env.CORE_DB, uid);
    if (!previous) return c.json({ error: '用户不可用' }, 403);
    const store = avatarStore(c.env, dependencies);
    if (!store && previous.avatarKey) return c.json({ error: '头像存储尚未配置' }, 503);
    const result = await c.env.CORE_DB.prepare(
      'UPDATE users SET avatar_key = ?, profile_revision = profile_revision + 1 WHERE id = ? AND status = ? AND avatar_key IS ?',
    ).bind('', uid, 'active', previous.avatarKey).run();
    if (!(result.meta.changes ?? 0)) return c.json({ error: '资料已在其他窗口更新，请重试' }, 409);
    if (previous.avatarKey) await store!.delete(previous.avatarKey).catch(() => console.warn('profile avatar cleanup failed'));
    return c.json({ avatarUrl: '' });
  });

  app.get('/api/avatars/:key', async (c) => {
    const key = c.req.param('key');
    if (!/^[a-f0-9-]{36}$/.test(key)) return c.json({ error: '头像不存在' }, 404);
    const owner = await c.env.CORE_DB.prepare('SELECT id FROM users WHERE avatar_key = ? AND status = ?').bind(key, 'active').first();
    if (!owner) return c.json({ error: '头像不存在' }, 404);
    const store = avatarStore(c.env, dependencies);
    if (!store) return c.json({ error: '头像存储尚未配置' }, 503);
    try {
      const object = await store.get(key);
      if (!object) return c.json({ error: '头像不存在' }, 404);
      return new Response(object.body, { headers: {
        'content-type': object.contentType,
        'cache-control': 'private, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
      } });
    } catch { return c.json({ error: '头像暂时不可用' }, 503); }
  });
}
