// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 会话：核心侧用户会话，签入 HttpOnly/SameSite=Lax Cookie（§5.2）。
 *
 * Cookie 值为签名的 token：`base64url(payload).base64url(hmac)`。
 * HMAC-SHA256 密钥用实例 JWT_PRIVATE_KEY 派生（HKDF，信息串 "unself:session"），
 * 不引入第二个 secret；JWKS 轮换即全会话失效（与 §5.2 短时 token 同节奏，可接受）。
 */
export const SESSION_COOKIE = 'unself_session';

/** 会话有效期（秒）：M0 取 7 天；登出/停用即时清 Cookie + 广播。 */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 会话 payload。 */
export interface SessionPayload {
  /** 核心内部稳定用户 id（users.id）。 */
  uid: string;
  /** 身份源 issuer（JIT 建档/审计用）。 */
  iss: string;
  /** 身份源 sub（issuer+sub 映射只存核心）。 */
  sub: string;
  /** 展示名（name / preferred_username / email）。 */
  name: string;
  /** UNIX 秒。 */
  exp: number;
}

/** b64url 编码（无 padding）。 */
export function b64urlEncode(input: string | Uint8Array): string {
  let bin: string;
  if (typeof input === 'string') {
    bin = String.fromCharCode(...new TextEncoder().encode(input));
  } else {
    bin = String.fromCharCode(...input);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** b64url 解码；非法输入返回 null。 */
export function b64urlDecode(input: string): Uint8Array | null {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** 由实例签名私钥派生会话 HMAC 密钥（HKDF-SHA256）。 */
async function deriveSessionKey(jwtPrivateKeyPem: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(jwtPrivateKeyPem);
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('unself-session-salt'),
      info: new TextEncoder().encode('unself:session'),
    },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

/** 签发会话：返回要写进 Cookie 的 token。 */
export async function createSessionToken(payload: Omit<SessionPayload, 'exp'>, jwtPrivateKeyPem: string): Promise<string> {
  const full: SessionPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const body = b64urlEncode(JSON.stringify(full));
  const key = await deriveSessionKey(jwtPrivateKeyPem);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** 校验并解析会话；无效/过期返回 null。 */
export async function verifySessionToken(token: string, jwtPrivateKeyPem: string): Promise<SessionPayload | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await deriveSessionKey(jwtPrivateKeyPem);
  const sigBytes = b64urlDecode(sig);
  if (!sigBytes) return null;
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes as unknown as ArrayBuffer,
    new TextEncoder().encode(body),
  );
  if (!ok) return null;
  const bodyBytes = b64urlDecode(body);
  if (!bodyBytes) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes)) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.uid !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** 会话 Cookie 参数：HttpOnly + SameSite=Lax + Secure，只在实例域名路径下。 */
export function sessionCookieOptions(): { path: '/'; httpOnly: true; sameSite: 'Lax'; secure: true; maxAge: number } {
  return { path: '/', httpOnly: true, sameSite: 'Lax', secure: true, maxAge: SESSION_TTL_SECONDS };
}

/** 从请求读会话；无 Cookie 或无效返回 null（供 API 与 shell 共用）。 */
export async function readSessionFromCookie(cookieHeader: string | undefined, jwtPrivateKey: string | undefined): Promise<SessionPayload | null> {
  const secret = jwtPrivateKey;
  let token: string | null = null;
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === SESSION_COOKIE) token = rest.join('=');
    }
  }
  if (!token || !secret) return null;
  return verifySessionToken(token, secret);
}

/** Hono 便捷封装：从上下文读会话。 */
export async function readSession(c: { req: { header(name: string): string | undefined }; env: { JWT_PRIVATE_KEY?: string } }): Promise<SessionPayload | null> {
  return readSessionFromCookie(c.req.header('cookie'), c.env.JWT_PRIVATE_KEY);
}
