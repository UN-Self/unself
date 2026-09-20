// SPDX-License-Identifier: AGPL-3.0-only
/**
 * keypair 行为回归（#244 REST 化后）：探测/写入已移至 rest/workers（rest-client.test 覆盖），
 * 这里只守密钥生成与 JWKS 形状契约——kty/crv/use/alg 齐全、私钥材料永不出现。
 */
import { describe, expect, it } from 'vitest';
import { createKeypair, JWT_SECRET_NAME, publicJwksJson } from '../../src/engine/keypair';

describe('createKeypair / publicJwksJson（既有行为回归）', () => {
  it('生成的密钥对能产出合法 JWKS（kty/crv/kid/use/alg 齐全，无私钥材料 d）', async () => {
    const pair = await createKeypair();
    const jwks = JSON.parse(publicJwksJson(pair)) as { keys: Array<Record<string, string>> };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256' });
    expect(jwks.keys[0]!.kid).toBe(pair.kid);
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });

  it('secret 名契约不变（core JWT_PRIVATE_KEY）', () => {
    expect(JWT_SECRET_NAME).toBe('JWT_PRIVATE_KEY');
  });
});
