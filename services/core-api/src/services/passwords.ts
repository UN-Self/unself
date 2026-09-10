// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 密码哈希域（issue-A，SPEC 决策 20/29）：内置账号的工作台登录密码。
 *
 * 口径：
 * - 只做 PBKDF2-SHA256（WebCrypto，Workers 与 Node≥22 内置，零新依赖、无 bcrypt）；
 * - 格式 `pbkdf2-sha256$<iter>$<salt-b64>$<hash-b64>`（标准 b64 带 padding），自描述、可升格；
 * - 随机盐 16 字节；迭代 210k（OWASP 2023 推荐档）；哈希 32 字节。
 */
export const PBKDF2_ITERATIONS = 210_000;
export const SALT_BYTES = 16;
export const HASH_BYTES = 32;

/** b64 标准编码（带 padding）。 */
function toB64(bytes: Uint8Array): string {
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

/**
 * 解析哈希串。格式不合法（段数/算法名/iter 非整数或 <1/盐哈希解码失败/长度非 32B）→ null。
 * 不做迭代上限校验：存储值来自本服务写入或未来升格，格式合法即按其参数验证。
 */
export function parsePasswordHash(
  stored: string,
): { iterations: number; salt: Uint8Array; hash: Uint8Array } | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') {
    return null;
  }
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) {
    return null;
  }
  const salt = fromB64(parts[2] ?? '');
  const hash = fromB64(parts[3] ?? '');
  if (!salt || !hash || salt.length !== SALT_BYTES || hash.length !== HASH_BYTES) {
    return null;
  }
  return { iterations, salt, hash };
}

/** 等长字节串常量时间比较（无早退）。 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/** PBKDF2-SHA256 派生。 */
async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as ArrayBuffer, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** 哈希：随机盐 + PBKDF2-SHA256(210k)，返回自描述存储串。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

/** 验证：解析失败 → false；派生结果与存储哈希常量时间比较。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) {
    return false;
  }
  const computed = await derive(password, parsed.salt, parsed.iterations);
  return constantTimeEqual(computed, parsed.hash);
}
