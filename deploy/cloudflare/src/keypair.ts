// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 实例签名密钥供给（§5.2 / #14）：幂等关键——
 * 已有 JWT_PRIVATE_KEY secret 则绝不重生成（重生成使存量 token/会话全部失效）；
 * 缺失时本地生成一次并经 REST 写入 secret。私钥只在内存存活，不落盘不打印。
 * #244：探测/写入走 CF REST（#65），本文件不再持有任何 wrangler 依赖。
 */
import { generateInstanceKeyPair, type InstanceKeyPair } from './es256';

/** core Worker 的默认 secret 名（core-api Bindings 契约）。 */
export const JWT_SECRET_NAME = 'JWT_PRIVATE_KEY';

/** 生成新 ES256 密钥对（本地 WebCrypto；仅缺失时调用）。 */
export function createKeypair(): Promise<InstanceKeyPair> {
  return generateInstanceKeyPair();
}

/**
 * 公钥 JWKS JSON 字符串（与 core keys.ts 的 toPublicJwks 同形状）：
 * `{ keys: [ { kty:'EC', crv:'P-256', x, y, kid, use:'sig', alg:'ES256' } ] }`。
 * 部署期注入各模块 vars.CORE_JWKS_JSON；私钥材料（d 等）永不出现。
 */
export function publicJwksJson(pair: InstanceKeyPair): string {
  return JSON.stringify({
    keys: [{ ...pair.publicJwk, kid: pair.kid, use: 'sig', alg: 'ES256' }],
  });
}
