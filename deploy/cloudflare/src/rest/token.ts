// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 凭证解析（决策 #65/#66）：优先级同官方——CLOUDFLARE_API_TOKEN > OAuth 借用。
 * OAuth 经 `wrangler auth token` 借用（官方文档明确支持 "for use with other tools and scripts"）；
 * 机器上没有 wrangler 时给人话（去哪登录 / 怎么给 token），不崩。
 * 生产代码只 spawn `wrangler auth token` 这一条只读命令，绝不安装/调用其他 wrangler 功能。
 */

export interface TokenSource {
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

export async function resolveToken(opts: ResolveTokenOptions = {}): Promise<TokenSource> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const envToken = env.CLOUDFLARE_API_TOKEN;
  if (envToken) {
    return { token: envToken, source: 'env' };
  }
  const bin = opts.wranglerBin ?? findWranglerBin(env);
  if (!bin) {
    throw new Error(
      '未找到 Cloudflare 凭证：\n' +
        '  ① export CLOUDFLARE_API_TOKEN=...（API Token， dash.cloudflare.com → My Profile → API Tokens）；\n' +
        '  ② 或先 `wrangler login` 完成浏览器授权（本工具会借用自己的 OAuth 令牌，官方支持「for use with other tools and scripts」）。',
    );
  }
  const execFile = opts.execFile ?? execFileAsync;
  const [cmd, ...args] = bin.startsWith('node ') ? ['node', bin.slice(5)] : [bin];
  const { stdout } = await execFile(cmd!, args);
  const token = parseWranglerTokenOutput(String(stdout ?? ''));
  if (!token) {
    throw new Error(
      'wrangler 已安装但未取到 OAuth 令牌（未登录或会话过期）：跑一次 `wrangler login` 完成浏览器授权后重试；' +
        '或直接 export CLOUDFLARE_API_TOKEN=... 走 API Token 路径。',
    );
  }
  log('凭证：借用 wrangler OAuth 令牌（官方支持「for use with other tools and scripts」）');
  return { token, source: 'wrangler-oauth' };
}

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb) as unknown as (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;
