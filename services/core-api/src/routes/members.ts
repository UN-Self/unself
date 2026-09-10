// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from 'hono';

import { audit } from '../services/audit';
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
}

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
      if (status === 'disabled') {
        await provisioner.disableAccount({ email: member.email });
      } else {
        await provisioner.enableAccount({ email: member.email });
      }
    }
  }
  return c.json({ id: member.id, status: member.status });
}
