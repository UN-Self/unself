// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  buildStoredCredential,
  fakeSaltFor,
  parseStoredCredential,
  verifyClientProof,
} from '../src/services/passwords';

/** 模拟客户端（shell 同款算法）：R = PBKDF2-SHA256(密码, 盐, 210k, 32B)。 */
async function clientDerive(password: string, saltB64: string): Promise<string> {
  const salt = Uint8Array.from(atob(saltB64), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as ArrayBuffer, iterations: 210_000 },
    key,
    256,
  );
  const bytes = new Uint8Array(bits);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

/** b64 → 字节（服务端收到的就是解码后的 R）。 */
function proofBytes(proofB64: string): Uint8Array {
  return Uint8Array.from(atob(proofB64), (ch) => ch.charCodeAt(0));
}

describe('pk1 凭证域（决策 35：KDF 在客户端，服务端只存 SHA256(R)）', () => {
  it('落库串自描述：unself-pk1$盐$摘要，盐 16B 摘要 32B 可解析', async () => {
    const salt = randomSalt();
    const proof = await clientDerive('correct horse', salt);
    const stored = await buildStoredCredential(salt, proof);
    const parsed = parseStoredCredential(stored);
    expect(stored.startsWith('unself-pk1$')).toBe(true);
    expect(parsed).not.toBeNull();
    expect(parsed!.salt.length).toBe(16);
    expect(parsed!.digest.length).toBe(32);
  });

  it('验证：正确 R 通过，错误 R、篡改存储串、垃圾串全拒绝', async () => {
    const salt = randomSalt();
    const stored = await buildStoredCredential(salt, await clientDerive('correct horse', salt));
    await expect(verifyClientProof(proofBytes(await clientDerive('correct horse', salt)), stored)).resolves.toBe(true);
    await expect(verifyClientProof(proofBytes(await clientDerive('wrong horse', salt)), stored)).resolves.toBe(false);
    const tamperedBytes = new Uint8Array(32);
    await expect(verifyClientProof(tamperedBytes, stored)).resolves.toBe(false);
    await expect(verifyClientProof(proofBytes(await clientDerive('correct horse', salt)), 'garbage')).resolves.toBe(false);
  });

  it('同一密码不同盐 → 不同存储串；服务端不派生，盐只是客户端元数据', async () => {
    const salt1 = randomSalt();
    const salt2 = randomSalt();
    const r1 = proofBytes(await clientDerive('same password', salt1));
    const r2 = proofBytes(await clientDerive('same password', salt2));
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
    const s1 = await buildStoredCredential(salt1, b64(r1));
    const s2 = await buildStoredCredential(salt2, b64(r1));
    expect(s1).not.toBe(s2);
    await expect(verifyClientProof(r1, s1)).resolves.toBe(true);
    await expect(verifyClientProof(r1, s2)).resolves.toBe(true); // 同一 R 配不同存储盐：服务端照过（它不算 KDF）
    await expect(verifyClientProof(r2, s2)).resolves.toBe(false); // 换盐派生的 R 对不上
  });

  it('假盐确定性且形状与真盐一致（防枚举）', async () => {
    const fake1 = await fakeSaltFor('alice');
    const fake2 = await fakeSaltFor('alice');
    const fake3 = await fakeSaltFor('bob');
    expect(fake1).toBe(fake2);
    expect(fake1).not.toBe(fake3);
    expect(fake1).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('恶意载荷：盐/R 长度不符直接拒绝（400 面，不落库）', async () => {
    await expect(buildStoredCredential('short', 'x'.repeat(44))).rejects.toThrow();
    await expect(buildStoredCredential(randomSalt(), 'not-base64!!')).rejects.toThrow();
  });
});
