// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 邀请域 HTTP（#18 链路 1）：
 * - 管理端 /api/admin/invites*：生成一次性邀请链接（明文只回一次）、全量列表、批准、拒绝；
 * - 公开 /api/invite/:token：填表页读取与提交（令牌即凭证，无会话）。
 *
 * 口径：
 * - 库里只有令牌 SHA-256（one-time-token.ts），明文只出现在生成响应的 URL 里；
 * - 批准 = 完整实例先 Stalwart 开户，再置 approved 并签一次性激活链接发个人邮箱；
 *   弱化实例（无 mail 段）跳过开户，只置 approved，首登 JIT 按个人邮箱消费邀请（#49）；
 * - 邮箱前缀被占用属可恢复冲突：邀请保持 pending，人话提示拒绝后重新邀请（M1 不改前缀）；
 * - 每个管理员动作落 audit（invite_created / invite_approved / invite_rejected）。
 */
import type { InviteStatus } from '@unself/contracts';
import { MailProvisionerError } from '@unself/stalwart-provisioner';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { Bindings, CoreApiDependencies } from '../index';
import { generateOneTimeToken, hashOneTimeToken } from '../one-time-token';
import { audit } from '../services/audit';
import { issueInviteActivation } from '../services/invite-activations';
import {
  createInvite,
  DEFAULT_INVITE_EXPIRES_DAYS,
  findInvite,
  getInviteCredentials,
  listInvites,
  setInviteStatus,
  updateInviteApplication,
  type Invite,
} from '../services/invites';
import { configuredMailProvisioner } from '../services/members';
import { configuredMailSender, deliverNotification } from '../services/notifications';
import { readSession } from '../session';

/** 生成邀请 body：有效天数可省（缺省 7 天）。 */
const CREATE_INVITE_SCHEMA = z.object({
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

/** 公开填表 body：三字段非空；前缀不含 @ 与空白；个人邮箱必须是合法地址。
 * 内置注册（issue-A 决策 28）：username+password 可选，两者必须同时有或同时无。 */
const APPLICATION_SCHEMA = z
  .object({
    displayName: z.string().trim().min(1),
    emailPrefix: z
      .string()
      .trim()
      .min(1)
      .regex(/^[^@\s]+$/, '邮箱前缀不能包含 @ 或空白'),
    personalEmail: z.string().trim().email(),
    username: z.string().trim().regex(/^[a-zA-Z0-9_-]{3,32}$/, '用户名需为 3-32 位字母/数字/_/-').optional(),
    password: z.string().min(8).optional(),
  })
  .refine((data) => (data.username === undefined) === (data.password === undefined), {
    message: '用户名和密码需同时填写',
    path: ['username'],
  });

/** 非 pending 状态的人话（409 detail；approve/reject 共用）。 */
function statusDetail(status: InviteStatus): string {
  switch (status) {
    case 'approved':
      return '该邀请已批准';
    case 'rejected':
      return '该邀请已拒绝';
    case 'expired':
      return '该邀请已过期';
    case 'consumed':
      return '该邀请已入职';
    default:
      return '该邀请仍在待审批';
  }
}

/** 管理端列表行：显式取列，due 是服务端内部判定列，不进 API 形状。 */
function inviteView(invite: Invite) {
  return {
    token_hash: invite.token_hash,
    status: invite.status,
    personal_email: invite.personal_email,
    email_prefix: invite.email_prefix,
    display_name: invite.display_name,
    created_at: invite.created_at,
    expires_at: invite.expires_at,
  };
}

/**
 * 挂载邀请域：管理端四端点 + 公开填表两端点。
 * 守卫由组合根统一挂载（requireAdmin，/api/admin/*）；此处只定义路由语义。
 */
export function registerInviteRoutes(
  app: Hono<{ Bindings: Bindings }>,
  dependencies: CoreApiDependencies = {},
): void {
  /** 生成邀请链接：明文 token 只在本响应里出现一次。 */
  app.post('/api/admin/invites', async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = CREATE_INVITE_SCHEMA.safeParse(raw ?? {});
    if (!parsed.success) {
      return c.json({ error: 'invalid invite options', detail: z.prettifyError(parsed.error) }, 400);
    }
    const db = c.env.CORE_DB;
    const token = generateOneTimeToken();
    const tokenHash = await hashOneTimeToken(token);
    await createInvite(db, tokenHash, parsed.data.expiresInDays ?? DEFAULT_INVITE_EXPIRES_DAYS);
    await audit(db, (await readSession(c))!.uid, 'invite_created', tokenHash);
    const inviteUrl = `${new URL(c.req.url).origin}/invite/${token}`;
    return c.json({ inviteUrl }, 201);
  });

  /** 全量列表（倒序，惰性过期已判）。 */
  app.get('/api/admin/invites', async (c) => {
    const invites = await listInvites(c.env.CORE_DB);
    return c.json(invites.map(inviteView));
  });

  /** 批准：开户（完整实例）→ approved → 激活链接 + 结果通知。 */
  app.post('/api/admin/invites/:id/approve', (c) =>
    approveInvite(c, c.req.param('id'), dependencies),
  );

  /** 拒绝：pending → rejected（终态）+ 结果通知。 */
  app.post('/api/admin/invites/:id/reject', (c) =>
    rejectInvite(c, c.req.param('id'), dependencies),
  );

  /** 公开读取：仅 pending 链接可用（过期行由 findInvite 惰性置 expired）。 */
  app.get('/api/invite/:token', async (c) => {
    const invite = await findInvite(c.env.CORE_DB, await hashOneTimeToken(c.req.param('token')));
    if (!invite) {
      return c.json({ error: '邀请链接无效' }, 404);
    }
    if (invite.status !== 'pending') {
      return c.json({ error: '邀请链接已过期或已被使用' }, 410);
    }
    return c.json({
      displayName: invite.display_name,
      emailPrefix: invite.email_prefix,
      personalEmail: invite.personal_email,
    });
  });

  /** 公开提交：落申请三字段（内置注册时另带用户名/密码）后广播 active 管理员（站内，不发邮件）。 */
  app.post('/api/invite/:token', async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = APPLICATION_SCHEMA.safeParse(raw ?? {});
    if (!parsed.success) {
      return c.json(
        {
          error: '请填写显示名、邮箱前缀和个人邮箱（邮箱需为有效地址）',
          detail: z.prettifyError(parsed.error),
        },
        400,
      );
    }
    const db = c.env.CORE_DB;
    const tokenHash = await hashOneTimeToken(c.req.param('token'));
    const invite = await findInvite(db, tokenHash);
    if (!invite) {
      return c.json({ error: '邀请链接无效' }, 404);
    }
    if (invite.status !== 'pending') {
      return c.json({ error: '邀请链接已过期或已被使用' }, 410);
    }
    // 用户名唯一性软闸（issue-A 决策 30）：users+invites 双表查重，重名即时 409
    if (parsed.data.username !== undefined) {
      const taken = await db
        .prepare(
          `SELECT 1 FROM users u JOIN builtin_credentials bc ON bc.user_id = u.id WHERE lower(bc.username) = lower(?)
           UNION ALL
           SELECT 1 FROM invite_credentials ic JOIN invites i ON i.token_hash = ic.token_hash WHERE lower(ic.username) = lower(?) AND i.status IN ('pending', 'approved')
           LIMIT 1`,
        )
        .bind(parsed.data.username, parsed.data.username)
        .first();
      if (taken) {
        return c.json({ error: '用户名已被占用' }, 409);
      }
    }
    const updated = await updateInviteApplication(db, tokenHash, parsed.data);
    if (!updated) {
      // SELECT 与 UPDATE 之间状态被改（竞态）：按链接失效回。
      return c.json({ error: '邀请链接已过期或已被使用' }, 410);
    }
    await deliverNotification(
      db,
      null,
      'invite_pending',
      {
        name: parsed.data.displayName,
        emailPrefix: parsed.data.emailPrefix,
        personalEmail: parsed.data.personalEmail,
      },
      { admins: true },
    );
    return c.json({ ok: true });
  });
}

/** 审批前统一校验：不存在 404；非 pending 409（人话 detail）。 */
async function requirePendingInvite(
  c: Context<{ Bindings: Bindings }>,
  id: string,
): Promise<Invite | Response> {
  const invite = await findInvite(c.env.CORE_DB, id);
  if (!invite) {
    return c.json({ error: 'invite not found' }, 404);
  }
  if (invite.status !== 'pending') {
    return c.json({ error: 'invite not pending', detail: statusDetail(invite.status) }, 409);
  }
  return invite;
}

/**
 * 批准：先看内置注册凭证（issue-A）——有则内置开户路径，无则 OIDC JIT 路径。
 * 邮件轴（provisioner/激活邮件）两条路径共用，行为不变。
 */
async function approveInvite(
  c: Context<{ Bindings: Bindings }>,
  id: string,
  dependencies: CoreApiDependencies,
): Promise<Response> {
  const db = c.env.CORE_DB;
  const session = (await readSession(c))!;
  const invite = await requirePendingInvite(c, id);
  if (invite instanceof Response) {
    return invite;
  }
  const sender = await configuredMailSender(db, dependencies.createMailSender);

  // 内置注册路径（issue-A 决策 28/30）：硬闸靠 builtin_credentials.username UNIQUE 约束，
  // 撞名走可恢复冲突：invite 留 pending + 人话，拒绝后让新人换名重提。
  const creds = await getInviteCredentials(db, id);
  if (creds) {
    const userId = `u_${crypto.randomUUID().replace(/-/g, '')}`;
    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO users (id, issuer, sub, display_name, email, personal_email, role, status) VALUES (?, 'builtin', ?, ?, NULL, ?, 'member', 'active')",
          )
          .bind(userId, userId, invite.display_name, invite.personal_email),
        db
          .prepare('INSERT INTO builtin_credentials (user_id, username, password_hash) VALUES (?, ?, ?)')
          .bind(userId, creds.username, creds.password_hash),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        return c.json(
          {
            error: 'invite approve failed',
            detail: `用户名「${creds.username}」已被占用，邀请保持待审批；请拒绝后让新人换一个用户名重新提交`,
          },
          409,
        );
      }
      throw error;
    }
  } else if (invite.email_prefix.length === 0) {
    // OIDC JIT 路径：未填表（无邮箱前缀）无法批准（内置路径没有邮箱前缀字段，不适用）
    return c.json(
      { error: 'invite not filled', detail: '该申请尚未填写完成（缺少邮箱前缀），无法批准' },
      409,
    );
  }

  // 邮件轴开户（完整实例）：内置路径也照旧开户发激活邮件（登录密码归登录、邮箱密码归激活，两码两用途）
  const provisioner = await configuredMailProvisioner(db, dependencies.createMailProvisioner);
  let workEmail: string | null = null;
  if (provisioner) {
    try {
      const account = await provisioner.createAccount({
        emailPrefix: invite.email_prefix,
        displayName: invite.display_name,
      });
      workEmail = account.email;
    } catch (error) {
      if (error instanceof MailProvisionerError && error.code === 'ACCOUNT_EXISTS') {
        // 可恢复冲突：邀请留在 pending，管理员拒绝后重新邀请（M1 不支持改前缀）。
        // 内置路径用户行已建：不回滚（用户存在但邮箱待补，invite 留 pending 可重批）。
        return c.json(
          {
            error: 'invite approve failed',
            detail: `邮箱前缀「${invite.email_prefix}」已被占用，邀请保持待审批；请拒绝后重新邀请（M1 不支持改前缀）`,
          },
          409,
        );
      }
      throw error;
    }
  }

  const approved = await setInviteStatus(db, id, 'pending', 'approved');
  if (!approved) {
    // 竞态：另一管理员先批准/拒绝/链接先过期。
    return c.json({ error: 'invite not pending', detail: '邀请状态已变化，请刷新后重试' }, 409);
  }

  if (provisioner && workEmail !== null) {
    const activationToken = await issueInviteActivation(db, id, workEmail);
    const activateUrl = `${new URL(c.req.url).origin}/activate/${activationToken}`;
    await deliverNotification(
      db,
      sender,
      'account_ready',
      { email: workEmail, activateUrl },
      { invitedEmail: invite.personal_email },
    );
  }
  await deliverNotification(
    db,
    sender,
    'invite_result',
    { approved: true, name: invite.display_name, approver: session.name },
    { invitedEmail: invite.personal_email },
  );
  await audit(db, session.uid, 'invite_approved', id);
  return c.json({ status: 'approved', email: workEmail });
}

/** 拒绝：置终态后回结果通知；未填表的邀请也可拒绝（撤销入口）。 */
async function rejectInvite(
  c: Context<{ Bindings: Bindings }>,
  id: string,
  dependencies: CoreApiDependencies,
): Promise<Response> {
  const db = c.env.CORE_DB;
  const session = (await readSession(c))!;
  const invite = await requirePendingInvite(c, id);
  if (invite instanceof Response) {
    return invite;
  }

  const rejected = await setInviteStatus(db, id, 'pending', 'rejected');
  if (!rejected) {
    return c.json({ error: 'invite not pending', detail: '邀请状态已变化，请刷新后重试' }, 409);
  }
  // 未填表的撤销没有申请人可通知（个人邮箱为空）：不落空收件人通知，只留审计。
  if (invite.personal_email.length > 0) {
    await deliverNotification(
      db,
      await configuredMailSender(db, dependencies.createMailSender),
      'invite_result',
      { approved: false, name: invite.display_name, approver: session.name },
      { invitedEmail: invite.personal_email },
    );
  }
  await audit(db, session.uid, 'invite_rejected', id);
  return c.json({ status: 'rejected' });
}
