// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { hashPassword, parsePasswordHash, verifyPassword } from '../src/services/passwords';

/** 纯函数单测（docs/testing.md：真正的纯逻辑才做单测——签名与格式解析在此列）。 */
describe('密码哈希（PBKDF2-SHA256，issue-A）', () => {
  it('hash → verify 正密码通过', async () => {
    const stored = await hashPassword('correct horse');
    expect(stored.startsWith('pbkdf2-sha256$210000$')).toBe(true);
    await expect(verifyPassword('correct horse', stored)).resolves.toBe(true);
  });

  it('错密码不通过；篡改哈希不通过', async () => {
    const stored = await hashPassword('correct horse');
    await expect(verifyPassword('wrong horse', stored)).resolves.toBe(false);
    // 篡改：换掉最后一段（哈希）再验证
    const parts = stored.split('$');
    const tampered = `${parts[0]}$${parts[1]}$${parts[2]}$${parts[3]!.slice(0, -2) == parts[3]!.slice(0, -2) ? flipB64(parts[3]!) : parts[3]!}`;
    await expect(verifyPassword('correct horse', tampered)).resolves.toBe(false);
  });

  it('同一密码两次哈希产生不同盐（盐随机）', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    const pa = parsePasswordHash(a);
    const pb = parsePasswordHash(b);
    expect(pa).not.toBeNull();
    expect(pb).not.toBeNull();
    // 盐不同但两者都能验证同一密码
    expect(Buffer.from(pa!.salt).equals(Buffer.from(pb!.salt))).toBe(false);
    await expect(verifyPassword('same-password', a)).resolves.toBe(true);
    await expect(verifyPassword('same-password', b)).resolves.toBe(true);
  });

  it('parsePasswordHash：合法格式解析出 iter/盐/哈希；非法输入回 null', async () => {
    const stored = await hashPassword('x');
    const parsed = parsePasswordHash(stored);
    expect(parsed).not.toBeNull();
    expect(parsed!.iterations).toBe(210_000);
    expect(parsed!.salt.length).toBe(16);
    expect(parsed!.hash.length).toBe(32);

    for (const bad of [
      '',
      'not-a-hash',
      'pbkdf2-sha1$210000$AAAA$BBBB',
      'pbkdf2-sha256$abc$AAAA$BBBB',
      'pbkdf2-sha256$0$AAAA$BBBB',
      'pbkdf2-sha256$210000$!!!$BBBB',
      'pbkdf2-sha256$210000$AAAA',
    ]) {
      expect(parsePasswordHash(bad)).toBeNull();
    }
  });
});

/** 翻转 b64 串的最后一个字符（制造篡改但保持可解码）。 */
function flipB64(s: string): string {
  const last = s[s.length - 1]!;
  const flipped = last === 'A' ? 'B' : 'A';
  return s.slice(0, -1) + flipped;
}
