// SPDX-License-Identifier: AGPL-3.0-only
/**
 * wrangler 探测与输出解析 + 旧版 resolveToken 兼容层（#246 迁移到 auth.ts 后保留）。
 * - parseWranglerTokenOutput / findWranglerBin：唯一实现在本文件（auth.ts 复用）；
 * - resolveToken：旧签名适配器，内部委托 resolveAuth（优先级/透传/注入语义一致）；
 *   差异：凭证缺失时不再给人话后 throw 两种文案，统一抛 CredentialsMissingError（人话在 message 里）。
 * 生产代码只 spawn `wrangler auth token` 这一条只读命令，绝不安装/调用其他 wrangler 功能（决策 #65）。
 */
import { credentialsMissingMessage, resolveAuth, type ExecFileLike } from '../auth';

/** 旧版来源形状（#246 前的公共面；新代码请用 auth.TokenSource）。 */
export interface LegacyTokenSource {
  token: string;
  /** 来源（日志/诊断用，不含值）。 */
  source: 'env' | 'wrangler-oauth';
}

export interface ResolveTokenOptions {
  env?: NodeJS.ProcessEnv;
  /** wrangler 可执行入口（缺省在常见 node_modules/.pnpm 布局下探测；空串 = 不借用）。 */
  wranglerBin?: string;
  /** 注入 spawn（测试替身）。 */
  execFile?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  log?: (msg: string) => void;
}

/** 从 wrangler 输出剥离装饰字符取 token：OAuth token 为长 base64url/jwt 形（≥40 连续 token 字符）。 */
export function parseWranglerTokenOutput(stdout: string): string | null {
  const matches = stdout.match(/[A-Za-z0-9._-]{40,}/g);
  if (!matches || matches.length === 0) return null;
  // 最长命中 = token 本体（wrangler 会打 ⛅ 等装饰与说明文字）
  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** 常见 pnpm 布局下找本机 wrangler（不安装、只借用已存在的）。 */
export function findWranglerBin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.UNSELF_WRANGLER_BIN) return env.UNSELF_WRANGLER_BIN;
  const bin = 'node_modules/.bin/wrangler';
  if (existsSync0(bin)) return bin;
  // pnpm 虚拟 store 兜底（安装器场景下仓库可能没有 .bin 链接）
  const store = 'node_modules/.pnpm';
  try {
    const entries = readdirSync0(store).filter((d) => d.startsWith('wrangler@'));
    if (entries.length > 0) {
      const candidate = `${store}/${entries.sort().pop()}/node_modules/wrangler/bin/wrangler.js`;
      if (existsSync0(candidate)) return `node ${candidate}`;
    }
  } catch {
    // 无 .pnpm 目录
  }
  return null;
}

import { existsSync as existsSync0, readdirSync as readdirSync0 } from 'node:fs';

/** 旧签名兼容层：委托 resolveAuth（#246）；缺凭证 → 抛 CredentialsMissingError（人话在 message）。 */
export async function resolveToken(opts: ResolveTokenOptions = {}): Promise<LegacyTokenSource> {
  const cred = await resolveAuth({
    env: opts.env,
    wranglerBin: opts.wranglerBin,
    execFile: opts.execFile ? (opts.execFile as unknown as ExecFileLike) : undefined,
    log: opts.log,
    probe: false, // 旧入口无「版本 ≠ 已验证 → 警告」语义，不追加探测
  });
  if (!cred) throw new Error(credentialsMissingMessage());
  const source: LegacyTokenSource['source'] = cred.source === 'env-api-token' ? 'env' : 'wrangler-oauth';
  return { token: cred.token, source };
}
