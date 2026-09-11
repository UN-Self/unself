// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 内置身份凭证域（pk1 协议，v2）。
 *
 * 协议（决策 35，SPEC §5.7 能力轴模型的「重算力还给客户端」）：
 *   客户端：R = PBKDF2-SHA256(密码, 盐, 210_000, 32B)；盐 16B 随机（注册/重置时客户端生成）。
 *   服务端：只存 `unself-pk1$<盐b64>$<SHA256(R)b64>`，验证 = SHA256(来件 R) 常量时间比对。
 *
 * 为什么服务端不跑 KDF：Cloudflare Workers 生产环境 WebCrypto PBKDF2 迭代上限
 * 100,000（workerd#1346，防 DoS 硬编码，付费版同样受限），210k 直接抛异常（#22
 * 验收走查实测：setup 500）。把 KDF 挪到客户端后平台上限失效，强度反升（210k >
 * 100k），服务端验证降到一次 SHA256。用户已认账的代价：密码策略只剩客户端
 * （服务端永不见密码）、登录依赖 JS（SPA 本就如此）。
 *
 * 约束：盐内嵌存储串（零表结构改动）；未知用户的假盐由 routes/auth.ts 按
 * 用户名确定性派生（形状与真盐一致，防枚举），本文件不管假盐。
 */

/** 客户端 KDF 参数（与 shell/src/lib/builtin-auth-api.ts 必须逐字一致）。 */
export const CLIENT_ITERATIONS = 210_000;
export const SALT_BYTES = 16;
export const R_BYTES = 32;

/** b64 标准编码（带 padding）。 */
export function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

/** b64 标准解码；非法输入回 null。 */
function fromB64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** 常量时间等长比较（无早退）。 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = 0;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * 解析存储串 `unself-pk1$<盐b64>$<SHA256b64>`。盐 16B、摘要 32B，段数/前缀/长度
 * 不符 → null（调用方一律按「凭证不存在或已损坏」处理）。
 */
export function parseStoredCredential(stored: string): { salt: Uint8Array; digest: Uint8Array } | null {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'unself-pk1') {
    return null;
  }
  const salt = fromB64(parts[1] ?? '');
  const digest = fromB64(parts[2] ?? '');
  if (!salt || !digest || salt.length !== SALT_BYTES || digest.length !== R_BYTES) {
    return null;
  }
  return { salt, digest };
}

/** SHA-256 摘要（32B）。 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer));
}

/**
 * 验证登录：来件 R 与存储摘要常量时间比对。存储串解析失败 → false。
 * 服务端总成本 = 一次 SHA256。
 */
export async function verifyClientProof(rawProof: Uint8Array, stored: string): Promise<boolean> {
  const parsed = parseStoredCredential(stored);
  if (!parsed) {
    return false;
  }
  return constantTimeEqual(await sha256(rawProof), parsed.digest);
}

/** 落库串：注册/setup/重置共用（来件盐+R 均为客户端生成）。 */
export async function buildStoredCredential(saltB64: string, proofB64: string): Promise<string> {
  const salt = fromB64(saltB64);
  const proof = fromB64(proofB64);
  if (!salt || salt.length !== SALT_BYTES || !proof || proof.length !== R_BYTES) {
    throw new Error('invalid credential payload');
  }
  return `unself-pk1$${saltB64}$${toB64(await sha256(proof))}`;
}

/**
 * 未知用户的确定性假盐（防枚举）：SHA256(固定域 || 用户名) 截 16B。
 * 与真盐同形状；对该盐算出的 R 落库必失败，无重放面。
 */
export async function fakeSaltFor(username: string): Promise<string> {
  const material = new TextEncoder().encode(`unself-pk1-salt:${username}`);
  return toB64((await sha256(material)).slice(0, SALT_BYTES));
}
