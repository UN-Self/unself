// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { audit } from '../services/audit';
import {
  classifyProvisionerFailure,
  type ClassifiedProvisionerFailure,
} from '../services/provisioner-errors';
import { buildStoredCredential } from '../services/passwords';
import {
  configuredMailProvisioner,
  listMembers,
  setMemberStatus,
  type CreateMailProvisioner,
  type MemberStatus,
} from '../services/members';
import { readSession } from '../session';
import { findInviteActivationForInvite, invalidateInviteActivation, issueInviteActivation } from '../services/invite-activations';
import { hashOneTimeToken } from '../one-time-token';
import { configuredMailSender, deliverNotification, type CreateMailSender } from '../services/notifications';
import { runInBackground } from '../services/notification-background';
import type { Bindings } from '../index';

/** 挂载管理端成员域（/api/admin/members）。 */
export function registerMemberRoutes(
  app: Hono<{ Bindings: Bindings }>,
  createMailProvisioner: CreateMailProvisioner | undefined,
  createMailSender?: CreateMailSender,
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
  /**
   * 重发激活链接（#152 改造）：后台尽力投递 + 投递成功才作废旧链接。
   *
   * 与旧实现的区别（旧：先作废旧令牌 → 再同步发信 → 失败 502）：
   * - 先签新令牌（不动旧令牌），响应立刻返回（有 executionCtx 时投递挂 waitUntil，#134 同口径）；
   * - 后台投递**成功后**才作废旧令牌：发信失败时旧链接原样可用，不会出现
   *   「旧链接被毁、新链接锁在发不出的邮件里」（D1 曾实锤 qweq 此状态）；
   * - 投递失败/未装配：作废本次未送达的新令牌，旧链接保留；不再用 502 表达投递失败。
   *
   * 并发（双击/双标签）：投递成功后用 `invalidateInviteActivation` 的 `used_at IS NULL` 守卫
   * 原子抢旧令牌——赢家保留自己的新令牌，输家（含被 claim 抢先重签）作废自己的新令牌退位，
   * 同一时刻至多一个有效链接。
   *
   * 防账号枚举：不存在与存在但非 builtin 的成员同回 404 { error: 'member not found' }，不区分。
   */
  app.post('/api/admin/members/:id/resend-activation', async (c) => {
    const db = c.env.CORE_DB;
    const memberId = c.req.param('id');
    const member = await db.prepare('SELECT id, issuer, status, personal_email FROM users WHERE id = ?').bind(memberId).first<{ id: string; issuer: string; status: string; personal_email: string | null }>();
    if (!member || member.issuer !== 'builtin') return c.json({ error: 'member not found' }, 404);
    if (member.status !== 'active') return c.json({ error: 'resend activation failed', detail: '成员当前未启用，无法重发激活邮件' }, 409);
    const invite = await db.prepare("SELECT token_hash, personal_email FROM invites WHERE status = 'approved' AND lower(personal_email) = lower(?) LIMIT 1").bind(member.personal_email ?? '').first<{ token_hash: string; personal_email: string }>();
    if (!invite) return c.json({ error: 'resend activation failed', detail: '该成员没有已批准的邀请，无法重发激活邮件' }, 409);
    const activation = await findInviteActivationForInvite(db, invite.token_hash);
    // used_at 非空＝链接已消费或被刷新作废：已激活或需本人在邀请页重新获取，管理员重发无从下手。
    if (!activation || activation.used_at !== null) return c.json({ error: 'resend activation failed', detail: '该成员没有待使用的激活链接（可能已激活），无需重发；如链接失效请让其从邀请页重新获取' }, 409);

    const actorId = (await readSession(c))!.uid;
    const sender = await configuredMailSender(db, createMailSender);
    // 先签新令牌、旧令牌原样保留：这封邮件发不出去时旧链接仍然可用。
    const newToken = await issueInviteActivation(db, invite.token_hash, activation.email);
    const activateUrl = new URL(c.req.url).origin + '/activate/' + newToken;
    await runInBackground(c, async () => {
      const result = await deliverNotification(db, sender, 'account_ready', { email: activation.email, activateUrl }, { invitedEmail: invite.personal_email });
      const sent = result?.email === 'sent';
      // 作废本不该留下的令牌：投递失败时是新令牌（从未送达），并发输家时是它自己的令牌（已退位）。
      const newTokenHash = await hashOneTimeToken(newToken);
      if (!sent) {
        await invalidateInviteActivation(db, newTokenHash);
        await audit(db, actorId, 'activation_resend_failed', memberId);
        return;
      }
      const won = await invalidateInviteActivation(db, activation.token_hash);
      if (!won) {
        await invalidateInviteActivation(db, newTokenHash);
      }
      await audit(db, actorId, 'activation_resent', memberId);
    });
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
  const actorId = (await readSession(c))!.uid;
  await audit(
    c.env.CORE_DB,
    actorId,
    status === 'disabled' ? 'member_disabled' : 'member_enabled',
    member.id,
  );
  if (member.email) {
    const provisioner = await configuredMailProvisioner(c.env.CORE_DB, createMailProvisioner);
    if (provisioner) {
      // 邮件轴联动失败不再裸 500（#115）：按错误轴映射——ACCOUNT_NOT_FOUND→409（Stalwart 后台核对）、
      // 认证失败（HTTP 401/403）→502+API Key 指引、其它→502 透传原因。成员状态翻转已落库，不回滚：
      // 修好 Stalwart 后反向 enable/disable 或后台手工对齐即可；同时落一行失败审计（#188 S5），
      // 否则「库说 disabled、邮箱还在用」的偏差在后台无痕可查。
      try {
        if (status === 'disabled') {
          await provisioner.disableAccount({ email: member.email });
        } else {
          await provisioner.enableAccount({ email: member.email });
        }
      } catch (error) {
        const failure = classifyProvisionerFailure(error, member.email);
        await audit(
          c.env.CORE_DB,
          actorId,
          status === 'disabled' ? 'member_disable_failed' : 'member_enable_failed',
          memberSyncFailureTarget(member.email, failure, error),
        );
        return c.json({ error: 'member sync failed', detail: failure.detail }, failure.status);
      }
    }
  }
  return c.json({ id: member.id, status: member.status });
}

/**
 * 联动失败审计的 target（#188 S5）：目标邮箱 + 分类映射 + 原始原因（人话外壳归 HTTP 响应体）。
 * 只进 audit_log，不改任何签名/表结构。
 */
function memberSyncFailureTarget(
  email: string,
  failure: ClassifiedProvisionerFailure,
  error: unknown,
): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${email}（HTTP ${failure.status}）：${reason}`;
}
