// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { audit } from '../services/audit';
import { classifyProvisionerFailure } from '../services/provisioner-errors';
import { buildStoredCredential } from '../services/passwords';
import {
  configuredMailProvisioner,
  listMembers,
  setMemberStatus,
  type CreateMailProvisioner,
  type MemberStatus,
} from '../services/members';
import { readSession } from '../session';
import type { Bindings } from '../index';

/** 挂载管理端成员域（/api/admin/members）。 */
export function registerMemberRoutes(
  app: Hono<{ Bindings: Bindings }>,
  createMailProvisioner: CreateMailProvisioner | undefined,
): void {
  /** 成员全量列表；邮箱是否存在由前端结合实例形态显示状态。 */
  app.get('/api/admin/members', async (c) => c.json(await listMembers(c.env.CORE_DB)));

  app.post('/api/admin/members/:id/disable', (c) =>
    updateMemberStatus(c, c.req.param('id'), 'disabled', createMailProvisioner),
  );
  app.post('/api/admin/members/:id/enable', (c) =>
    updateMemberStatus(c, c.req.param('id'), 'active', createMailProvisioner),
  );

  /**
   * 手动重置内置登录密码（issue-A，决策 29：忘记密码 = 管理员手动重置，无邮件实例唯一恢复路径）。
   * 仅内置用户（有 builtin_credentials 行）可重置；OIDC 用户密码在身份源，409 人话。
   */
  app.post('/api/admin/members/:id/reset-password', async (c) => {
    const db = c.env.CORE_DB;
    const memberId = c.req.param('id');
    const body = RESET_PASSWORD_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: '凭据格式不正确' }, 400);
    }
    const row = await db
      .prepare(
        'SELECT u.id AS user_id, bc.user_id AS builtin_id FROM users u LEFT JOIN builtin_credentials bc ON bc.user_id = u.id WHERE u.id = ?',
      )
      .bind(memberId)
      .first<{ user_id: string; builtin_id: string | null }>();
    if (!row) {
      return c.json({ error: 'member not found' }, 404);
    }
    if (row.builtin_id === null) {
      return c.json({ error: '该成员无内置登录' }, 409);
    }
    await db
      .prepare('UPDATE builtin_credentials SET password_hash = ? WHERE user_id = ?')
      .bind(await buildStoredCredential(body.data.salt, body.data.proof), memberId)
      .run();
    await audit(db, (await readSession(c))!.uid, 'member_password_reset', memberId);
    return c.json({ ok: true });
  });
}

/** 重置密码 body（issue-A + pk1）：盐/R 均为管理员浏览器客户端生成（决策 35）。 */
const RESET_PASSWORD_SCHEMA = z.object({
  salt: z.string().regex(/^[A-Za-z0-9+/]{22}==$/, '凭据格式不正确'),
  proof: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, '凭据格式不正确'),
});

/** 状态翻转、可选邮件账户联动和审计属于同一成员生命周期动作。 */
async function updateMemberStatus(
  c: Context<{ Bindings: Bindings }>,
  memberId: string,
  status: MemberStatus,
  createMailProvisioner: CreateMailProvisioner | undefined,
): Promise<Response> {
  const member = await setMemberStatus(c.env.CORE_DB, memberId, status);
  if (!member) {
    return c.json({ error: 'member not found' }, 404);
  }
  await audit(
    c.env.CORE_DB,
    (await readSession(c))!.uid,
    status === 'disabled' ? 'member_disabled' : 'member_enabled',
    member.id,
  );
  if (member.email) {
    const provisioner = await configuredMailProvisioner(c.env.CORE_DB, createMailProvisioner);
    if (provisioner) {
      // 邮件轴联动失败不再裸 500（#115）：按错误轴映射——ACCOUNT_NOT_FOUND→409（Stalwart 后台核对）、
      // 认证失败（HTTP 401/403）→502+API Key 指引、其它→502 透传原因。成员状态翻转已落库，不回滚：
      // 修好 Stalwart 后反向 enable/disable 或后台手工对齐即可。
      try {
        if (status === 'disabled') {
          await provisioner.disableAccount({ email: member.email });
        } else {
          await provisioner.enableAccount({ email: member.email });
        }
      } catch (error) {
        const failure = classifyProvisionerFailure(error, member.email);
        return c.json({ error: 'member sync failed', detail: failure.detail }, failure.status);
      }
    }
  }
  return c.json({ id: member.id, status: member.status });
}
