// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 激活域 HTTP（#18 链路 1 完整实例）：/api/activate/:token，公开端点（无会话）。
 *
 * 口径（SPEC §5.7 / 2026-09-10 拍板）：
 * - GET 只验不消费，给激活页展示工作邮箱；POST 消费一次性令牌（原子）后调
 *   MailProvisioner.resetPassword 设**邮箱密码**（与工作台登录 IdP 账号无关）；
 * - 弱化实例（无 mail 段）POST 一律 503 且不消费令牌：等实例补配邮件后同一链接仍可用；
 * - 令牌明文只出现在邮件链接里，库里只有 SHA-256（one-time-token.ts）；
 * - 激活只改邮箱侧密码，不建用户档案（工作台首登 JIT 建档，#49）；
 * - resetPassword 失败按 #115 状态码口径映射（#150）：409/502 + activate 语境人话，
 *   #151 修正：resetPassword 失败时**精确回滚本次消费**（密码没设上不烧链接，可原地重试）；
 *   回滚精确守卫到本次写入的 used_at，期间被 claim 重签作废的令牌不会误放行。
 */
import { Hono } from 'hono';
import { z } from 'zod';

import type { Bindings, CoreApiDependencies } from '../index';
import { hashOneTimeToken } from '../one-time-token';
import { audit } from '../services/audit';
import { consumeInviteActivation, findInviteActivation, releaseInviteActivation } from '../services/invite-activations';
import { configuredMailProvisioner } from '../services/members';
import {
  activationFailureDetail,
  activationRetryDetail,
  classifyProvisionerFailure,
} from '../services/provisioner-errors';

/** 激活 body：自设邮箱密码（下限 8 位，M1 不引入强度规则）。 */
const PASSWORD_SCHEMA = z.object({
  password: z.string().min(8),
});

/** 链接失效统一人话：不区分不存在/已使用/已过期（不泄露令牌状态机）。 */
const INVALID_LINK = '激活链接无效、已使用或已过期';

/** 成功后的登录指引：Unself 只开邮箱，登录身份仍归团队 IdP（SPEC §5.7 表）。 */
const LOGIN_HINT =
  '请使用邮箱账号与刚设置的密码登录工作台；若团队登录使用独立 IdP，登录账号请联系管理员开通';

/** 挂载激活域（公开，登录态无关；链接双证之一是邮箱所有权）。 */
export function registerActivateRoutes(
  app: Hono<{ Bindings: Bindings }>,
  dependencies: CoreApiDependencies = {},
): void {
  /** 读取激活页所需工作邮箱（不消费令牌）。 */
  app.get('/api/activate/:token', async (c) => {
    const activation = await findInviteActivation(
      c.env.CORE_DB,
      await hashOneTimeToken(c.req.param('token')),
    );
    if (!activation) {
      return c.json({ error: INVALID_LINK }, 404);
    }
    return c.json({ email: activation.email });
  });

  /** 自设邮箱密码：校验密码 → 验实例形态 → 原子消费令牌 → resetPassword → 审计。 */
  app.post('/api/activate/:token', async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = PASSWORD_SCHEMA.safeParse(raw ?? {});
    if (!parsed.success) {
      return c.json({ error: '密码至少 8 位' }, 400);
    }

    const db = c.env.CORE_DB;
    // 先验形态再消费：弱化实例点激活不能白烧一次性令牌（补配邮件后链接仍可用）。
    const provisioner = await configuredMailProvisioner(db, dependencies.createMailProvisioner);
    if (!provisioner) {
      return c.json({ error: '实例未配置邮件服务，无法设置邮箱密码，请联系管理员' }, 503);
    }

    const activation = await consumeInviteActivation(
      db,
      await hashOneTimeToken(c.req.param('token')),
    );
    if (!activation) {
      return c.json({ error: INVALID_LINK }, 404);
    }
    // resetPassword 失败不裸 500（#150）：状态码按 #115 同口径映射（ACCOUNT_NOT_FOUND→409、
    // 密码策略→400、认证失败 HTTP 401/403→502+API Key 指引、其它→502）。
    // #151：先前置消费 + 失败回滚（精确守卫到本次写入的 used_at）——密码没设上就不该烧链接，
    // 用户可拿同一条链接直接重试；回滚命中与否决定人话走「重试」还是「重新获取」出路。
    try {
      await provisioner.resetPassword({ email: activation.email, password: parsed.data.password });
    } catch (error) {
      const failure = classifyProvisionerFailure(error, activation.email);
      const released = await releaseInviteActivation(
        db,
        await hashOneTimeToken(c.req.param('token')),
        activation.used_at,
      );
      await audit(db, 'system', 'activation_reset_failed', activation.email);
      const detail = released
        ? activationRetryDetail(failure.detail)
        : activationFailureDetail(failure.detail);
      return c.json({ error: detail }, failure.status);
    }
    await audit(db, 'system', 'account_activated', activation.email);
    return c.json({ ok: true, loginHint: LOGIN_HINT });
  });
}
