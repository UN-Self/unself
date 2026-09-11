// SPDX-License-Identifier: AGPL-3.0-only

/**
 * pk1 客户端派生（决策 35）：KDF 在浏览器跑，服务端只存 SHA256(R)。
 * 动机：CF Workers 生产环境 WebCrypto PBKDF2 迭代上限 100k（workerd#1346），
 * 服务端跑不了 210k；挪到客户端后平台上限失效、强度反升、服务端验证 O(1)。
 * 与 services/core-api/src/services/passwords.ts 的注释口径必须逐字一致。
 */
export const PK1_ITERATIONS = 210_000

function b64(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin)
}

/** 注册/重置时生成新盐（16B）。登录不生成——盐由服务端 /api/auth/salt 给。 */
export function generateSalt(): string {
  return b64(crypto.getRandomValues(new Uint8Array(16)))
}

/** R = PBKDF2-SHA256(密码, 盐, 210k, 32B)，b64 上送。约 100-200ms，表单提交场景无感。 */
export async function deriveProof(password: string, saltB64: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: Uint8Array.from(atob(saltB64), (ch) => ch.charCodeAt(0)) as unknown as ArrayBuffer,
      iterations: PK1_ITERATIONS,
    },
    key,
    256,
  )
  return b64(new Uint8Array(bits))
}
