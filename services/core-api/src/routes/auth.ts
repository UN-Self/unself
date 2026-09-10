// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';

import {
  buildAuthorizationRequest,
  discover,
  exchangeAuthorizationCode,
  fetchUserInfo,
  pickScope,
  type AuthorizationRequest,
  type CallbackResult,
  type DiscoveredMetadata,
} from '../oidc';
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from '../session';
import { getOidcConfig } from '../services/instance-config';
import { consumeApprovedInviteByEmail } from '../services/invites';
import { pickDisplayName, pickEmail, pickNameOrNull, upsertUser } from '../services/users';
import type { Bindings } from '../index';

/** 登录流程 Cookie：HttpOnly，10 分钟有效，仅 /api/auth 路径可见。 */
const FLOW_COOKIE = 'unself_oidc_flow';
const FLOW_TTL_SECONDS = 600;

/** 挂载 OIDC 登录域（/api/auth/*）与 OIDC 探测（/api/oidc/test-connection）。 */
export function registerAuthRoutes(app: Hono<{ Bindings: Bindings }>): void {
  /** 发起登录：302 到身份源授权页（整页跳转，壳里是一个按钮，§6.5）。 */
  app.get('/api/auth/login', async (c) => {
    const config = await getOidcConfig(c);
    if (!config) {
      return c.json({ error: 'OIDC not configured (run setup first)' }, 503);
    }
    const metadata = await discover(config.issuer);
    // #55：scope 按 discovery scopes_supported 过滤（向导默认三件；Stalwart 只支持 openid 时降级只发 openid）
    const flow = await buildAuthorizationRequest(
      { ...config, scope: pickScope(config.scope, metadata) },
      metadata,
    );
    setCookie(c, FLOW_COOKIE, JSON.stringify(flow), {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
      maxAge: FLOW_TTL_SECONDS,
    });
    return c.redirect(flow.authorizeUrl);
  });

  /**
   * OIDC callback 失败 → 短错误码（#60 T4）：
   * 只映射到固定枚举，不把内部细节（如 IdP 返回的 error_description）带进 URL。
   * LoginView.vue 消费 route.query.error 仅展示人话（"登录校验失败…"）。
   */
  function oidcErrorCode(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('state mismatch')) return 'oidc_state_mismatch';
    if (message.includes('id_token expired')) return 'oidc_token_expired';
    if (message.includes('provider returned')) return 'oidc_provider_error';
    return 'oidc_failed';
  }

  /** 失败态统一出口：清流程 Cookie（该轮流程作废）+ 302 回登录页带短错误码。 */
  function redirectToLoginError(c: Context<{ Bindings: Bindings }>, err: unknown): Response {
    deleteCookie(c, FLOW_COOKIE, { path: '/' });
    return c.redirect(`/login?error=${encodeURIComponent(oidcErrorCode(err))}`);
  }

  /** 授权回调：state/PKCE/nonce 校验 → 换 token → JIT 建档 → 签会话 Cookie。 */
  app.get('/api/auth/callback', async (c) => {
    const config = await getOidcConfig(c);
    if (!config) {
      return c.json({ error: 'OIDC not configured' }, 503);
    }
    const raw = getCookie(c, FLOW_COOKIE);
    if (!raw) {
      return c.json({ error: 'login flow expired, retry login' }, 400);
    }
    let flow: AuthorizationRequest;
    try {
      flow = JSON.parse(raw) as AuthorizationRequest;
    } catch {
      return c.json({ error: 'corrupted login flow cookie' }, 400);
    }
    // 换 token/验签失败态：不抛未捕获异常（避免 500），统一 302 回登录页（§6.5）。
    let result: CallbackResult;
    let metadata: DiscoveredMetadata;
    try {
      metadata = await discover(config.issuer);
      result = await exchangeAuthorizationCode(config, metadata, c.req.url, {
        state: flow.state,
        nonce: flow.nonce,
        codeVerifier: flow.codeVerifier,
      });
    } catch (err) {
      return redirectToLoginError(c, err);
    }
    deleteCookie(c, FLOW_COOKIE, { path: '/' });

    // 身份字段：id_token 优先，缺 email/name 时用 access_token 调 userinfo 兜底（#49）
    const claims = await resolveClaims(metadata, result);
    const email = pickEmail(claims);
    const name = pickDisplayName(claims);

    // JIT 建档（requirements #20：OIDC 首登自动建档复用；issuer+sub 映射只存核心）
    const { id: uid, created } = await upsertUser(c.env.CORE_DB, {
      issuer: config.issuer,
      sub: String(result.claims.sub),
      name,
      email,
    });
    // 弱化实例首登：email claim 匹配已批准邀请 → 消费（大小写不敏感；三分支见 services/invites）
    if (created && email) {
      await consumeApprovedInviteByEmail(c.env.CORE_DB, uid, email);
    }

    // 回原目标（直访落工作台由 shell 处理；这里只接受站内路径）
    const next = sanitizeNext(new URL(c.req.url).searchParams.get('next'));

    const secret = c.env.JWT_PRIVATE_KEY;
    if (!secret) {
      return c.json({ error: 'signing key not provisioned (run deploy bootstrap)' }, 503);
    }
    const token = await createSessionToken(
      { uid, iss: config.issuer, sub: String(result.claims.sub), name },
      secret,
    );
    setCookie(c, SESSION_COOKIE, token, sessionCookieOptions());
    return c.redirect(next ?? '/');
  });

  /** 登出：清会话 Cookie（§5.2 壳广播登出消息给模块由 shell 完成）。 */
  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  /**
   * 搭建向导 test-connection（#44）：服务端代理探测 issuer 发现文档。
   * 浏览器直连会被 IdP CORS 拦（Stalwart 实测命中），改经 core-api。
   * 匿名可调：只回结构化结果（成功含端点、失败统一不透传内部细节）。
   */
  app.post('/api/oidc/test-connection', async (c) => {
    const parsed = z.object({ issuer: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ ok: false, error: 'body must be { issuer: string }' }, 400);
    }
    const { issuer } = parsed.data;
    let issuerUrl: URL;
    try {
      issuerUrl = new URL(issuer);
    } catch {
      return c.json({ ok: false, error: 'issuer must be https' }, 400);
    }
    // 与 oidc.ts discover() 一致：https 门禁（NODE_ENV=test 允许 http）
    if (issuerUrl.protocol !== 'https:' && process.env.NODE_ENV !== 'test') {
      return c.json({ ok: false, error: 'issuer must be https' }, 400);
    }
    try {
      const metadata = await discover(issuer);
      return c.json({
        ok: true,
        issuer: metadata.issuer,
        authorization_endpoint: metadata.authorization_endpoint,
        token_endpoint: metadata.token_endpoint,
      });
    } catch {
      // 匿名调用方不透传内部错误（discover 错误可能含 fetch 详情/内网地址）
      return c.json({ ok: false, error: 'discovery failed' }, 502);
    }
  });
}

/**
 * 登录身份字段（#49）：id_token claims 为真值；id_token 缺 email 或 name（name/
 * preferred_username，email 不算名字）且发现文档有 userinfo_endpoint 时用 access_token 补齐
 * （宽松合并，id_token 已有字段优先）。
 */
async function resolveClaims(
  metadata: DiscoveredMetadata,
  result: CallbackResult,
): Promise<Record<string, unknown>> {
  const missing = !pickEmail(result.claims) || !pickNameOrNull(result.claims);
  if (!missing || !metadata.userinfo_endpoint || !result.accessToken) return result.claims;
  const info = await fetchUserInfo(metadata.userinfo_endpoint, result.accessToken);
  if (!info) return result.claims;
  return {
    ...result.claims,
    ...(pickEmail(result.claims) ? {} : { email: info.email }),
    ...(pickNameOrNull(result.claims) ? {} : { name: info.name }),
  };
}

/** 站内回跳白名单：仅允许本站绝对路径。 */
function sanitizeNext(next: string | null): string | null {
  if (!next) return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  return next;
}
