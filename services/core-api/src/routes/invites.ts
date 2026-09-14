// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 邀请域 HTTP（#18 链路 1）：
 * - 管理端 /api/admin/invites*：生成一次性邀请链接（明文只回一次）、全量列表、批准、拒绝；
 * - 公开 /api/invite/:token：填表页读取与提交（令牌即凭证，无会话）。
 *
 * 口径：
 * - 库里只有令牌 SHA-256（one-time-token.ts），明文只出现在生成响应的 URL 里；
 * - 批准 = 完整实例先 Stalwart 开户，成功后才落成员行（#114），再置 approved 并签一次性激活链接发个人邮箱；
 *   弱化实例（无 mail 段）跳过开户，只置 approved，首登 JIT 按个人邮箱消费邀请（#49）；
 * - 邮箱前缀被占用属可恢复冲突：邀请保持 pending，人话提示拒绝后重新邀请（M1 不改前缀）；
 * - 每个管理员动作落 audit（invite_created / invite_approved / invite_rejected）。
 */
import type { InviteStatus, InviteStatusResponse } from '@unself/contracts';
import { MailProvisionerError } from '@unself/contracts';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { Bindings, CoreApiDependencies } from '../index';
import { generateOneTimeToken, hashOneTimeToken } from '../one-time-token';
import { classifyProvisionerFailure, genericFailureDetail } from '../services/provisioner-errors';
import { audit } from '../services/audit';
import {
  findInviteActivationForInvite,
  invalidateInviteActivation,
  issueInviteActivation,
} from '../services/invite-activations';
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
import { configuredMailProvisioner, isMailEnabled } from '../services/members';
import { configuredMailSender } from '../services/notifications';
import { deliverNotificationInBackground } from '../services/notification-background';
import { readSession } from '../session';

/** 生成邀请 body：有效天数可省（缺省 7 天）。 */
const CREATE_INVITE_SCHEMA = z.object({
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

/**
 * 公开填表 body（按实例形态条件化，#149）：公共部分 displayName 必填；内置注册（issue-A）
 * username/salt/proof 可选、username 与 proof 必须同时有或同时无。
 * mailEnabled=true：emailPrefix 必填（不含 @ 与空白）且 personalEmail 必须是合法地址（与原全局 schema 逐字一致）；
 * mailEnabled=false：两字段可省（可省，带了值也接受——弱化实例无开户动作，批准即激活）。
 */
function applicationSchema(mailEnabled: boolean) {
  return z
    .object({
      displayName: z.string().trim().min(1),
      emailPrefix: mailEnabled
        ? z
            .string()
            .trim()
            .min(1)
            .regex(/^[^@\s]+$/, '邮箱前缀不能包含 @ 或空白')
        : z.string().trim().optional(),
      personalEmail: mailEnabled ? z.string().trim().email() : z.string().trim().optional(),
      username: z.string().trim().regex(/^[a-zA-Z0-9_-]{3,32}$/, '用户名需为 3-32 位字母/数字/_/-').optional(),
      salt: z.string().regex(/^[A-Za-z0-9+/]{22}==$/, '凭据格式不正确').optional(),
      proof: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, '凭据格式不正确').optional(),
    })
    .refine((data) => (data.username === undefined) === (data.proof === undefined), {
      message: '用户名和密码需同时填写',
      path: ['username'],
    });
}

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

  /**
   * #134 状态查询（凭令牌即身份，公开）：注册后的邀请页轮询它切三态。
   * activated 判定：邀请已入职（consumed）或激活令牌已用（密码已设完）。
   */
  app.get('/api/invite/:token/status', async (c) => {
    const invite = await findInvite(c.env.CORE_DB, await hashOneTimeToken(c.req.param('token')));
    if (!invite) {
      return c.json({ error: '邀请链接无效' }, 404);
    }
    // 能力开关一次算好，三态响应统一携带（前端据此决定表单字段与三态文案）
    const mailEnabled = await isMailEnabled(c.env.CORE_DB);
    if (invite.status === 'pending') {
      const body: InviteStatusResponse = { status: 'pending', mailEnabled };
      return c.json(body);
    }
    if (invite.status === 'expired' || invite.status === 'rejected') {
      // 对申请人只暴露 pending/approved/activated 三语义：expired/rejected 是管理侧事实，
      // 对外一律人话「已失效」（不泄露状态机细节）。
      return c.json({ error: '邀请链接已失效，请联系管理员' }, 410);
    }
    if (invite.status === 'consumed') {
      const body: InviteStatusResponse = { status: 'activated', mailEnabled };
      return c.json(body);
    }
    const activation = await findInviteActivationForInvite(c.env.CORE_DB, invite.token_hash);
    const activated = !activation || activation.used_at !== null;
    const body: InviteStatusResponse = { status: activated ? 'activated' : 'approved', mailEnabled };
    return c.json(body);
  });

  /**
   * #134 claim 激活入口（公开，凭令牌即身份）：approved 且存在未用激活令牌才放行。
   * 动作：原子作废旧激活 → 重签新令牌 → 返回明文 activationUrl（不落库，哈希铁律不破）。
   * 同一时刻至多一个有效明文链接：并发双 claim 只有一方作废成功，败方 409 人话。
   */
  app.post('/api/invite/:token/claim-activation', async (c) => {
    const db = c.env.CORE_DB;
    const tokenHash = await hashOneTimeToken(c.req.param('token'));
    const invite = await findInvite(db, tokenHash);
    if (!invite) {
      return c.json({ error: '邀请链接无效' }, 404);
    }
    if (invite.status === 'pending') {
      return c.json({ error: '管理员审批中，批准后才能设置邮箱密码' }, 409);
    }
    if (invite.status === 'rejected' || invite.status === 'expired') {
      return c.json({ error: '邀请链接已过期或已被使用' }, 410);
    }
    if (invite.status === 'consumed') {
      return c.json({ error: '已激活过，请直接登录' }, 409);
    }
    // approved：看最新激活行 —— 无行/已用＝历史激活已消费（或从未签发）→ 引导直接登录。
    const activation = await findInviteActivationForInvite(db, tokenHash);
    if (!activation || activation.used_at !== null) {
      return c.json({ error: '已激活过，请直接登录' }, 409);
    }
    // 原子作废（#81 原子模式）：并发双 claim 只有一方拿到行；败方拿不到新链接，
    // 胜方的新链接立即生效，旧明文从此无效（重签-作废模型）。
    const invalidated = await invalidateInviteActivation(db, activation.token_hash);
    if (!invalidated) {
      return c.json({ error: '激活链接已刷新，请重试' }, 409);
    }
    const workEmail = activation.email;
    const newToken = await issueInviteActivation(db, tokenHash, workEmail);
    const activationUrl = `${new URL(c.req.url).origin}/activate/${newToken}`;
    await audit(db, 'system', 'activation_claimed', tokenHash);
    return c.json({ activationUrl, email: workEmail });
  });

  /** 公开提交：落申请三字段（内置注册时另带用户名/密码）后广播 active 管理员（站内，不发邮件）。 */
  app.post('/api/invite/:token', async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    // 先判实例形态再校验：mail 段有无决定 emailPrefix/personalEmail 是否必填（#149）
    const mailEnabled = await isMailEnabled(c.env.CORE_DB);
    const parsed = applicationSchema(mailEnabled).safeParse(raw ?? {});
    if (!parsed.success) {
      return c.json(
        {
          error: mailEnabled
            ? '请填写显示名、邮箱前缀和个人邮箱（邮箱需为有效地址）'
            : '请填写显示名',
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
    // 落库与站内通知统一用归一化对象：mailEnabled=false 时可省字段归空串（updateInviteApplication 要 string）
    const normalized = {
      displayName: parsed.data.displayName,
      emailPrefix: parsed.data.emailPrefix ?? '',
      personalEmail: parsed.data.personalEmail ?? '',
      username: parsed.data.username,
      salt: parsed.data.salt,
      proof: parsed.data.proof,
    };
    const updated = await updateInviteApplication(db, tokenHash, normalized);
    if (!updated) {
      // SELECT 与 UPDATE 之间状态被改（竞态）：按链接失效回。
      return c.json({ error: '邀请链接已过期或已被使用' }, 410);
    }
    await deliverNotificationInBackground(
      c,
      db,
      null,
      'invite_pending',
      {
        name: normalized.displayName,
        emailPrefix: normalized.emailPrefix,
        personalEmail: normalized.personalEmail,
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
 * 批准（#114 顺序）：完整实例先开户（provisioner.createAccount），成功后才落成员行
 * （内置注册建 users+builtin_credentials；OIDC JIT 路径无行可落），再置 approved、
 * 最后签激活链接发通知。开户失败零成员落库、邀请保持 pending（可重批），杜绝
 * 旧顺序「先落行后开户」失败留下的可登录幽灵成员；ACCOUNT_EXISTS 属可恢复冲突照旧 409。
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

  // OIDC JIT 路径：未填表无法批准，守卫按实例形态（#149）：有邮件=看邮箱前缀；
  // 无邮件=看 displayName（无邮件实例表单不再采集邮箱前缀，OIDC+无邮件（无内置凭证）
  // 若仍按前缀判定将永 409，批准成死路；有邮件实例行为不变）。
  const mailEnabled = await isMailEnabled(db);
  const creds = await getInviteCredentials(db, id);
  if (!creds && (mailEnabled ? invite.email_prefix.length === 0 : invite.display_name.length === 0)) {
    return c.json(
      {
        error: 'invite not filled',
        detail: mailEnabled ? '该申请尚未填写完成（缺少邮箱前缀），无法批准' : '该申请尚未填写完成，无法批准',
      },
      409,
    );
  }

  // 邮件轴开户（完整实例）：#114 起先开户后落成员行——旧顺序先插 users/builtin_credentials
  // 再开户，开户失败留下「可登录幽灵成员」且重批必撞 UNIQUE 409；新顺序失败零落库、
  // 邀请保持 pending 可重批。内置路径也照旧开户发激活邮件（登录密码归登录、邮箱密码归激活，两码两用途）。
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
        // 可恢复冲突：邀请留在 pending，重批时开户会再试一次；拒绝后重新邀请（M1 不支持改前缀）。
        // 成员行尚未落库：不存在「用户已建但邮箱待补」的半完成态。
        return c.json(
          {
            error: 'invite approve failed',
            detail: `邮箱前缀「${invite.email_prefix}」已被占用，邀请保持待审批；请拒绝后重新邀请（M1 不支持改前缀）`,
          },
          409,
        );
      }
      // 开户失败（#114 零落库/pending 不变；#115 状态码按错误轴精修）：
      // ACCOUNT_NOT_FOUND→409（人话指向 Stalwart 后台）、认证失败（HTTP 401/403）→502+API Key 指引、
      // 其它→502 透传原因；detail 均保 #114 的「邮箱开户失败：…，邀请保持待审批」人话外壳。
      const failure = classifyProvisionerFailure(error, invite.email_prefix);
      return c.json(
        {
          error: 'invite approve failed',
          detail: failure.status === 502 ? genericFailureDetail(failure.detail) : failure.detail,
        },
        failure.status,
      );
    }
  }

  // 开户成功（或弱化实例无开户）才落成员行。内置注册路径（issue-A 决策 28/30）：
  // 硬闸靠 builtin_credentials.username UNIQUE 约束，撞名走可恢复冲突：invite 留 pending + 人话。
  // 与旧顺序不同，此刻 Stalwart 已建号：409 文案补一句预创建说明，不做回滚。
  if (creds) {
    const userId = `u_${crypto.randomUUID().replace(/-/g, '')}`;
    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO users (id, issuer, sub, display_name, email, personal_email, role, status) VALUES (?, 'builtin', ?, ?, ?, ?, 'member', 'active')",
          )
          .bind(userId, userId, invite.display_name, workEmail, invite.personal_email),
        db
          .prepare('INSERT INTO builtin_credentials (user_id, username, password_hash) VALUES (?, ?, ?)')
          .bind(userId, creds.username, creds.password_hash),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        return c.json(
          {
            error: 'invite approve failed',
            detail: `用户名「${creds.username}」已被占用，邀请保持待审批；请拒绝后让新人换一个用户名重新提交（邮箱账号已预创建，拒绝本邀请后请管理员在 Stalwart 删除或改用该用户名）`,
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
    // #134 发信后台化：邮箱密码改为被邀请人凭邀请令牌自助 claim（邀请页大按钮），
    // 邮件只是尽力增强，不能再挂死审批按钮（CF 上发信必超时）。两条投递顺序保持
    // account_ready → invite_result（先链接后结果，与站内阅读顺序一致）。
    await deliverNotificationInBackground(
      c,
      db,
      sender,
      'account_ready',
      { email: workEmail, activateUrl },
      { invitedEmail: invite.personal_email },
    );
  }
  await deliverNotificationInBackground(
    c,
    db,
    sender,
    'invite_result',
    { approved: true, name: invite.display_name, approver: session.name },
    { invitedEmail: invite.personal_email },
  );
  // 审计同步落（本地 D1 写，代价小）：审批动作本身不等后台发信就有痕可查。
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
    await deliverNotificationInBackground(
      c,
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
