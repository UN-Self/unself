// SPDX-License-Identifier: AGPL-3.0-only
import {
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  type CryptoKey,
} from 'jose';

/**
 * Core 实例签名密钥（ES256 / P-256）：
 * - 部署/首启时生成一次（deploy 脚本或 core-api 首启自检，见 #14/#16）；
 * - 私钥入 wrangler secret（`JWT_PRIVATE_KEY`，PKCS8 PEM），公钥经 JWKS 端点公开；
 * - 全平台一个 JWKS，模块只验签（PRODUCT_SPEC §5.2）。
 */

/** 当前实例签名密钥的 JWK thumbprint（RFC 7638），作 JWKS `kid` 与 token `kid`。 */
export type Kid = string;

/** 可持久化/可恢复的实例密钥对形状。 */
export interface InstanceKeyPair {
  /** PKCS8 PEM，入 wrangler secret（`JWT_PRIVATE_KEY`）。 */
  privateKeyPem: string;
  /** SPKI PEM（备份/人工核查用；JWKS 由公钥 JWK 推导）。 */
  publicKeyPem: string;
  /** 公钥 JWK（kty/crv/x/y），JWKS keys[0] 的来源。 */
  publicJwk: Record<string, unknown>;
  /** RFC 7638 thumbprint，作 kid。 */
  kid: Kid;
}

/** 生成新 ES256 密钥对并导出为可持久化形状。 */
export async function generateInstanceKeyPair(): Promise<InstanceKeyPair> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  const [privateKeyPem, publicKeyPem, kid] = await Promise.all([
    exportPKCS8(privateKey),
    exportSPKI(publicKey),
    calculateJwkThumbprint({ ...publicJwk } as Parameters<typeof calculateJwkThumbprint>[0]),
  ]);
  return { privateKeyPem, publicKeyPem, publicJwk, kid };
}

/** 从 wrangler secret（PKCS8 PEM）恢复私钥用于签名（可导出，供同源派生公钥 JWKS）。 */
export function importPrivateKey(pem: string): Promise<CryptoKey> {
  return importPKCS8(pem, 'ES256', { extractable: true });
}

/** 从 wrangler secret（SPKI PEM）恢复公钥（部署自检用）。 */
export function importPublicKey(pem: string): Promise<CryptoKey> {
  return importSPKI(pem, 'ES256');
}

/** JWKS 响应体。私钥材料（d 等）永不出现。 */
export interface Jwks {
  keys: Array<Record<string, unknown>>;
}

/**
 * 由公钥 JWK 组装 JWKS 响应体：只取公钥白名单字段 + kid/use/alg，
 * 传入对象若带私钥材料（d 等）一律剥除，杜绝误入响应。
 */
export function toPublicJwks(publicJwk: Record<string, unknown>, kid: Kid): Jwks {
  const { d: _d, dp: _dp, dq: _dq, p: _p, q: _q, qi: _qi, k: _k, ...pub } = publicJwk;
  void _d; void _dp; void _dq; void _p; void _q; void _qi; void _k;
  return {
    keys: [{ ...pub, kid, use: 'sig', alg: 'ES256' }],
  };
}

/** 运行时派生量：从 secret 恢复的签名私钥与配套 JWKS。 */
export interface SigningRuntime {
  signingKey: CryptoKey;
  jwks: Jwks;
  /** 与 JWKS keys[0].kid 一致，#3 签发 token 时放进 JOSE 头。 */
  kid: Kid;
}

/**
 * 由 JWT_PRIVATE_KEY（PKCS8 PEM）派生签名私钥与 JWKS（懒派生，调用方缓存）。
 * 私钥 PEM 不含 kid：公钥 JWK 从私钥 JWK 剥离 d 得出（严格同源），
 * kid 用 RFC 7638 thumbprint，签发头与 JWKS 天然一致，无第二个真值来源。
 */
export async function deriveSigningRuntime(privateKeyPem: string): Promise<SigningRuntime> {
  const signingKey = await importPrivateKey(privateKeyPem);
  const privateJwk = (await exportJWK(signingKey)) as Record<string, unknown>;
  const { d: _d, ...publicJwk } = privateJwk;
  const kid = await calculateJwkThumbprint({ ...publicJwk } as Parameters<typeof calculateJwkThumbprint>[0]);
  return { signingKey, jwks: toPublicJwks(publicJwk, kid), kid };
}
