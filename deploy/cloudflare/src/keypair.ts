// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 实例签名密钥供给（§5.2 / #14）：幂等关键——
 * 已有 JWT_PRIVATE_KEY secret 则绝不重生成（重生成使存量 token/会话全部失效）；
 * 缺失时本地生成一次并 wrangler secret put。私钥只在管道内存活，不落盘不打印。
 */
import { execFile } from 'node:child_process';
import { generateInstanceKeyPair, type InstanceKeyPair } from './es256';

/** core Worker 的 secret 名（core-api Bindings 契约）。 */
export const JWT_SECRET_NAME = 'JWT_PRIVATE_KEY';

export type KeypairOutcome =
  | { action: 'existing' }
  | { action: 'created'; pair: InstanceKeyPair };

/** 探测 Worker 是否已配置签名私钥 secret。Worker 不存在 → 视为缺失。 */
export async function detectExistingSecret(
  wrangler: { tryRun(args: string[]): Promise<{ ok: boolean; stdout: string }> },
  workerName: string,
): Promise<boolean> {
  const res = await wrangler.tryRun(['secret', 'list', '--name', workerName]);
  if (!res.ok) return false;
  try {
    // wrangler v4：secret list 默认即 JSON（--format json），但输出可能带日志前缀；取最后一个 '[' 起的 JSON 数组
    const start = res.stdout.lastIndexOf('[');
    const parsed: unknown = JSON.parse(start >= 0 ? res.stdout.slice(start) : res.stdout.trim() || '[]');
    if (Array.isArray(parsed)) {
      return parsed.some((s) => (s as Record<string, unknown>).name === JWT_SECRET_NAME);
    }
  } catch {
    // 解析失败按缺失处理（后续 put 幂等覆盖）
  }
  return false;
}

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

/**
 * wrangler secret put（值经 stdin 管道喂入：不出现在 argv/日志/落盘）。
 * 返回 secret 的 sha256 指纹前 16 位（部署输出备查，不含密钥本体）。
 */
export async function putSecret(
  wranglerBin: string,
  cwd: string,
  workerName: string,
  value: string,
  log: (msg: string) => void = console.log,
): Promise<void> {
  log(`写入 secret ${JWT_SECRET_NAME} → ${workerName}（值不落盘）`);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      wranglerBin,
      ['secret', 'put', JWT_SECRET_NAME, '--name', workerName],
      { cwd, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
      (err) => (err ? reject(new Error(`secret put 失败：${err.message}`)) : resolve()),
    );
    child.stdin?.write(value);
    child.stdin?.end();
  });
}
