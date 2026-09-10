// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 一次性令牌（#18 邀请链接 / 激活链接）：明文只回给生成方一次并只出现在 URL 里，
 * 库里只留 SHA-256 哈希（invites.token_hash / invite_activations.token_hash）。
 * 随机源与形状沿用 #81 setup token（crypto.getRandomValues → base64url 无 padding，
 * URL 路径安全）；32 字节抗枚举。
 */

/** 令牌随机长度（字节）。 */
const TOKEN_BYTES = 32;

/** 生成一次性令牌明文（只此一次使用，勿落库）。 */
export function generateOneTimeToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 令牌 → SHA-256 十六进制（落库/查库统一口径，明文永不进库）。 */
export async function hashOneTimeToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
