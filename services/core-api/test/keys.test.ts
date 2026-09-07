// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { exportJWK, importSPKI, jwtVerify, SignJWT } from 'jose';

import app, { getSigningRuntime } from '../src/index';
import { deriveSigningRuntime, generateInstanceKeyPair, toPublicJwks } from '../src/keys';

describe('keys：ES256 密钥体系', () => {
  it('generateInstanceKeyPair 产出可互相恢复的 PEM 对', async () => {
    const pair = await generateInstanceKeyPair();
    expect(pair.privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
    expect(pair.publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(pair.publicJwk.kty).toBe('EC');
    expect(pair.publicJwk.crv).toBe('P-256');
    // kid 是合法的 base64url thumbprint（43 字符、无 +/-）
    expect(pair.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 公钥侧无私钥材料
    expect(pair.publicJwk.d).toBeUndefined();
  });

  it('deriveSigningRuntime：私钥派生的 JWKS 与签名严格同源', async () => {
    const pair = await generateInstanceKeyPair();
    const runtime = await deriveSigningRuntime(pair.privateKeyPem);
    expect(runtime.kid).toBe(pair.kid);
    expect(runtime.jwks.keys).toHaveLength(1);
    const key = runtime.jwks.keys[0] as Record<string, unknown>;
    expect(key.kid).toBe(pair.kid);
    expect(key.use).toBe('sig');
    expect(key.alg).toBe('ES256');
    expect(key.d).toBeUndefined();
    // 同一 PEM 派生两次，thumbprint 一致
    const again = await deriveSigningRuntime(pair.privateKeyPem);
    expect(again.kid).toBe(pair.kid);
  });

  it('JWKS 公钥可验签私钥签出的 token（jose 闭环）', async () => {
    const pair = await generateInstanceKeyPair();
    const runtime = await deriveSigningRuntime(pair.privateKeyPem);
    const jwt = await new SignJWT({ sub: 'mod-a' })
      .setProtectedHeader({ alg: 'ES256', kid: runtime.kid })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(runtime.signingKey);
    const jwk = runtime.jwks.keys[0] as Record<string, unknown>;
    const { pubkey } = { pubkey: await importSPKI(pair.publicKeyPem, 'ES256') };
    const verifiedByPem = await jwtVerify(jwt, pubkey);
    expect(verifiedByPem.payload.sub).toBe('mod-a');
    // 再走 JWK 导入路径（模块后端拿 JWKS 的真实路径）
    const publicJwk = await exportJWK(pubkey);
    expect(publicJwk.x).toBe(jwk.x);
    expect(publicJwk.y).toBe(jwk.y);
  });

  it('toPublicJwks 不回传私钥材料', () => {
    const jwks = toPublicJwks({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'SECRET' }, 'kid-1');
    expect(JSON.stringify(jwks)).not.toContain('SECRET');
    // 只取白名单字段 + kid/use/alg
    expect(jwks.keys[0]).toEqual({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', kid: 'kid-1', use: 'sig', alg: 'ES256' });
  });
});

describe('JWKS 端点', () => {
  it('未配置 JWT_PRIVATE_KEY 时返回 503', async () => {
    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(503);
  });

  it('配置 secret 后返回真实公钥（curl JWKS → jose 验签闭环）', async () => {
    const pair = await generateInstanceKeyPair();
    const env = { JWT_PRIVATE_KEY: pair.privateKeyPem } as unknown as Record<string, unknown>;

    const res = await app.request('/.well-known/jwks.json', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('max-age');
    const jwks = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBe(pair.kid);
    expect(jwks.keys[0]?.kty).toBe('EC');

    // 验收路径：用 JWKS 里的公钥验签一个由该实例私钥签出的 token
    const runtime = await getSigningRuntime(pair.privateKeyPem);
    expect(runtime).not.toBeNull();
    const jwt = await new SignJWT({ sub: 'u1', aud: 'hello' })
      .setProtectedHeader({ alg: 'ES256', kid: runtime!.kid })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(runtime!.signingKey);
    const verified = await jwtVerify(jwt, await importJwk(jwks.keys[0]!));
    expect(verified.payload.aud).toBe('hello');
    // kid 头与 JWKS kid 一致，jose createRemoteJWKSet 按 kid 选钥可命中
    expect(verified.protectedHeader.kid).toBe(jwks.keys[0]?.kid);
  });

  it('换 secret（换钥）后 JWKS 同步更新', async () => {
    const a = await generateInstanceKeyPair();
    const b = await generateInstanceKeyPair();
    const resA = await app.request('/.well-known/jwks.json', {}, { JWT_PRIVATE_KEY: a.privateKeyPem });
    const jwksA = (await resA.json()) as { keys: Array<Record<string, unknown>> };
    const resB = await app.request('/.well-known/jwks.json', {}, { JWT_PRIVATE_KEY: b.privateKeyPem });
    const jwksB = (await resB.json()) as { keys: Array<Record<string, unknown>> };
    expect(jwksA.keys[0]?.kid).not.toBe(jwksB.keys[0]?.kid);
  });
});

/** 模块后端验签的真实路径：从 JWKS 单钥导入公钥（剥去 kid/use/alg 元数据）。 */
async function importJwk(jwk: Record<string, unknown>): Promise<CryptoKey> {
  const { importJWK } = await import('jose');
  const { kid, use, alg, ...publicJwk } = jwk;
  void kid;
  void use;
  void alg;
  return importJWK(publicJwk, 'ES256') as Promise<CryptoKey>;
}
