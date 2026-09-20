// SPDX-License-Identifier: AGPL-3.0-only

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * OIDC 会话配置（PRODUCT_SPEC §5.2 / requirements #4）：
 * - 全系统只有核心对接外部 OIDC；发现 + 授权码 PKCE + callback 换 token；
 * - 会话 Cookie HttpOnly/SameSite=Lax/Secure，只在实例域名上；
 * - OIDC 凭证不入 unself.config.jsonc，setup 向导录入后存 core 库（§5.5）。
 *
 * 运行环境：Workers（fetch/WebCrypto 原生）；测试跑 Node 22+ 同原语。
 */

/** setup 向导录入、存 core 库的 OIDC 客户端配置。 */
export interface OidcClientConfig {
  /** 身份源 Issuer（如 https://stalwart.example.com）。 */
  issuer: string;
  /** OIDC Client ID。 */
  clientId: string;
  /** OIDC Client Secret（§5.5 已知缺口：core D1 无字段级加密，审计记录读取）。 */
  clientSecret: string;
  /** 授权请求 scope，至少含 openid（默认 'openid profile email'）。 */
  scope: string;
  /** 授权回调地址（完整 URL，与 IdP 登记一致）。 */
  redirectUri: string;
}

/** OpenID Discovery 文档中本流程消费的字段。 */
export interface DiscoveredMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  /** JWKS 集合地址（id_token 验签用；标准 IdP 必有，发现文档缺失则拒）。 */
  jwks_uri?: string;
  userinfo_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  /** id_token 可携带的 claim 集合（向导黄牌用：#17）；旧 IdP 可能缺省。 */
  claims_supported?: string[];
}

/** 发现缓存条目：元数据 + 拉取时间（15 分钟 TTL）。 */
interface DiscoveryCacheEntry {
  metadata: DiscoveredMetadata;
  fetchedAt: number;
}

const DISCOVERY_TTL_MS = 15 * 60 * 1000;

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

/** id_token 签名算法白名单：仅非对称带密钥协商的 RS/ES/PS（256/384/512），禁 HS 共享秘密类。 */
const ID_TOKEN_ALGS: string[] = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'];

/**
 * 进程内 JWKS 集合缓存：键 = issuer，值 = jose remote set（自带 10 分钟 JWKS 缓存
 * + unknown kid 冷启动重取）。换序测试/换钥测试务必先 resetOidcCaches，避免残留旧钥。
 */
const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** 清空进程内缓存（发现文档 + JWKS 集合）；测试隔离用。 */
export function resetOidcCaches(): void {
  discoveryCache.clear();
  jwksSets.clear();
}

/** OIDC Discovery（.well-known/openid-configuration），带进程内缓存；仅 https（测试可放宽）。 */
export async function discover(issuer: string): Promise<DiscoveredMetadata> {
  const cached = discoveryCache.get(issuer);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return cached.metadata;
  }
  const issuerUrl = new URL(issuer);
  if (issuerUrl.protocol === 'http:' && process.env.NODE_ENV !== 'test') {
    throw new Error('oidc: issuer must be https');
  }
  const wellKnown = new URL(
    issuerUrl.pathname === '/' ? '/.well-known/openid-configuration' : `${issuerUrl.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`,
    `${issuerUrl.protocol}//${issuerUrl.host}`,
  );
  const res = await fetch(wellKnown, { redirect: 'manual' });
  if (!res.ok) {
    throw new Error(`oidc: discovery failed (${res.status})`);
  }
  const metadata = (await res.json()) as DiscoveredMetadata;
  if (metadata.issuer !== issuer && metadata.issuer.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) {
    throw new Error('oidc: issuer mismatch in discovery document');
  }
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error('oidc: discovery document missing endpoints');
  }
  if (!metadata.jwks_uri) {
    // id_token 验签的前提（标准 IdP 必有）；缺失 → 拒绝（fail-closed）
    throw new Error('oidc: discovery document missing jwks_uri');
  }
  discoveryCache.set(issuer, { metadata, fetchedAt: now });
  return metadata;
}

/** 授权 scope 允许集：向导与默认配置只覆盖这三种（M0 不消费其余 claims）。 */
const SCOPE_ALLOWED = ['openid', 'profile', 'email'] as const;

/**
 * 按发现文档 scopes_supported 过滤授权 scope（#55 附带修复）：
 * - 只保留 [openid, profile, email] 与 IdP 声明支持的集合的交集；
 * - 交集为空 → 只发 openid（PKCE 登录最低要求）；
 * - scopes_supported 字段缺失 → 维持三件（旧 IdP 不拦）。
 */
export function pickScope(configured: string, metadata: DiscoveredMetadata): string {
  if (!metadata.scopes_supported || metadata.scopes_supported.length === 0) {
    return 'openid profile email';
  }
  const supported = new Set(metadata.scopes_supported);
  const requested = new Set(configured.split(/\s+/).filter(Boolean));
  const picked = SCOPE_ALLOWED.filter((s) => supported.has(s) && requested.has(s));
  return picked.length > 0 ? picked.join(' ') : 'openid';
}

/** 授权请求要携带的临时参数（每轮登录唯一，进 HttpOnly Cookie）。 */
export interface AuthorizationRequest {
  /** 跳转 IdP 的完整 URL（含 client_id/state/nonce/PKCE）。 */
  authorizeUrl: string;
  /** CSRF 防护：请求/回跳必须一致。 */
  state: string;
  /** 重放防护：进 id_token 校验。 */
  nonce: string;
  /** PKCE 校验器（仅服务端暂存，永不外发）。 */
  codeVerifier: string;
}

/** 生成随机字符串（WebCrypto，URL-safe base64）。 */
function randomB64url(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 组装授权码 + PKCE（S256）授权请求 URL。
 * PKCE 而非 state 作为主要 CSRF 防护（openid-client 同规），state 双保险。
 */
export async function buildAuthorizationRequest(
  config: OidcClientConfig,
  metadata: DiscoveredMetadata,
): Promise<AuthorizationRequest> {
  const state = randomB64url();
  const nonce = randomB64url();
  const codeVerifier = randomB64url(48);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  const codeChallenge = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { authorizeUrl: url.toString(), state, nonce, codeVerifier };
}

/** callback 请求已校验通过后的结果。 */
export interface CallbackResult {
  /** IdP 颁发的 ID token（JWT；已验签+claims 校验，可作身份真值）。 */
  idToken: string;
  /** ID token payload（含 iss/sub/aud/nonce/exp）。 */
  claims: Record<string, unknown>;
  /** IdP access token（M0 不消费，保留给远期 profile/userinfo）。 */
  accessToken?: string;
  /** IdP refresh token（IdP 未发则缺省）。 */
  refreshToken?: string;
}

/**
 * callback：校验 state/iss/aud/nonce/exp + 换 token + PKCE code_verifier。
 * 全部失败路径抛错（调用方回登录页并提示）。
 */
export async function exchangeAuthorizationCode(
  config: OidcClientConfig,
  metadata: DiscoveredMetadata,
  callbackUrl: string,
  expected: { state: string; nonce: string; codeVerifier: string },
): Promise<CallbackResult> {
  const url = new URL(callbackUrl);
  const error = url.searchParams.get('error');
  if (error) {
    throw new Error(`oidc: provider returned ${error}: ${url.searchParams.get('error_description') ?? ''}`);
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code) throw new Error('oidc: callback missing code');
  if (!state || state !== expected.state) throw new Error('oidc: state mismatch (possible CSRF)');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: expected.codeVerifier,
  });
  const res = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (!res.ok) {
    throw new Error(`oidc: token exchange failed (${res.status})`);
  }
  const token = (await res.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
  };
  if (!token.id_token) throw new Error('oidc: token response missing id_token');

  // ID token 验签：issuer JWKS（发现文档 jwks_uri）+ 算法白名单；
  // JWKS 拉取失败 / 找不到匹配 key / 签名不符 → 抛错拒绝登录（fail-closed）。
  let claims: Record<string, unknown>;
  try {
    const { payload } = await jwtVerify(token.id_token, jwksSetFor(metadata), {
      algorithms: ID_TOKEN_ALGS,
    });
    claims = payload as unknown as Record<string, unknown>;
  } catch (err) {
    // jose 的过期错误不带 /expired/ 字样；统一成本库错误，调用方按人话提示
    if ((err as { code?: string }).code === 'ERR_JWT_EXPIRED') {
      throw new Error('oidc: id_token expired');
    }
    throw err;
  }
  // claims 级核心校验（iss/aud/nonce/exp/sub）
  const iss = claims.iss as string;
  if (iss.replace(/\/$/, '') !== metadata.issuer.replace(/\/$/, '')) {
    throw new Error('oidc: id_token iss mismatch');
  }
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(config.clientId) : aud === config.clientId;
  if (!audOk) throw new Error('oidc: id_token aud mismatch');
  if (claims.nonce !== expected.nonce) throw new Error('oidc: id_token nonce mismatch');
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('oidc: id_token expired');
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('oidc: id_token missing sub');

  return {
    idToken: token.id_token,
    claims,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
  };
}

/** userinfo 松校验：M1 只消费 email/name（可选字段），其余字段忽略。 */
const UserInfoSchema = z.object({
  email: z.string().optional(),
  name: z.string().optional(),
});

export type UserInfoClaims = z.infer<typeof UserInfoSchema>;

/**
 * userinfo 兜底（#49）：id_token 缺 email/name 时用 access_token 补齐再建档。
 * access_token 只在此步用（不落库、不透传前端）；外部边界失败（网络/非 2xx/不合形）
 * 返回 null——id_token 已是登录真值，兜底失败不阻断建档。
 */
export async function fetchUserInfo(
  userinfoEndpoint: string,
  accessToken: string,
): Promise<UserInfoClaims | null> {
  try {
    const res = await fetch(userinfoEndpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    if (!res.ok) return null;
    const parsed = UserInfoSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * 取 issuer 对应的 remote JWKS 集合（进程内缓存）。
 * jose 集合自带：JWKS 拉取缓存（默认 10 分钟）、unknown kid 冷却后重取、失败抛错。
 */
function jwksSetFor(metadata: DiscoveredMetadata): ReturnType<typeof createRemoteJWKSet> {
  if (!metadata.jwks_uri) {
    throw new Error('oidc: discovery document missing jwks_uri');
  }
  let set = jwksSets.get(metadata.issuer);
  if (!set) {
    set = createRemoteJWKSet(new URL(metadata.jwks_uri));
    jwksSets.set(metadata.issuer, set);
  }
  return set;
}
