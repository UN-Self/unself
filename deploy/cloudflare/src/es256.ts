// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ES256 实例密钥生成（deploy 侧最小副本）：
 * 与 services/core-api/src/keys.ts 的 generateInstanceKeyPair 同构（jose generateKeyPair +
 * PKCS8/SPKI 导出 + RFC 7638 thumbprint）。不 import core 源码，避免把 Workers 类型
 * 拖进 deploy 包的 Node 类型空间。
 */
import {
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
} from 'jose';

/** 可持久化/可恢复的实例密钥对形状（与 core-api InstanceKeyPair 一致）。 */
export interface InstanceKeyPair {
  /** PKCS8 PEM，入 wrangler secret（JWT_PRIVATE_KEY）。 */
  privateKeyPem: string;
  /** SPKI PEM（备份/人工核查用）。 */
  publicKeyPem: string;
  /** 公钥 JWK（kty/crv/x/y），JWKS keys[0] 的来源。 */
  publicJwk: Record<string, unknown>;
  /** RFC 7638 thumbprint，作 kid。 */
  kid: string;
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
