// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cloudflare 凭证与授权路径（决策 #65/#66，issue #246）。
 *
 * 优先级同官方：CLOUDFLARE_API_TOKEN > API key/email > OAuth；
 * OAuth 不自己跑授权流程，而是经 `wrangler auth token` 借用（官方文档明确支持
 * "for use with other tools and scripts"；keyring 加密时同样走该命令，由 wrangler 自行解密）。
 * 机器上没有 wrangler → 返回 null，调用方给 API Token 人话指引（不回落、不装 wrangler）。
 *
 * 平台触点（env / spawn / 存在性）全部注入：测试在 Linux 上用注入参数覆盖
 * Windows/macOS/WSL 分支（决策 #67），不碰真实机器。
 * 禁令：任何路径都不得把 token 明文写进日志 / 落盘 / URL——本文件只回传内存值。
 */
import { homedir as osHomedir, platform as osPlatform } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { wranglerConfigDirFor, wranglerVersionWarning, parseWranglerVersionOutput, type PlatformId } from './platform';
import { findWranglerBin, parseWranglerTokenOutput } from './rest/token';

/** 凭证来源（日志/诊断用，不含值）。 */
export type TokenSourceKind = 'env-api-token' | 'env-api-key' | 'wrangler-oauth';

export interface TokenSource {
  /** Bearer 令牌（env-api-token / wrangler-oauth）；env-api-key 时为 API key 本体。 */
  token: string;
  source: TokenSourceKind;
  /** 诊断行（打印用；不含 token 明文）。 */
  note: string;
  /** OAuth 路径的警告（wrangler 版本 ≠ 已验证版本 4.129.0 等）；其余路径无此键。 */
  warning?: string;
  /** 仅 env-api-key：Global Key 必须配 email（X-Auth-Email/X-Auth-Key 头）。 */
  authEmail?: string;
}

/** 环境变量触点（注入：测试传字面量；生产 = process.env 子集）。 */
export interface AuthEnv {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_API_KEY?: string;
  CLOUDFLARE_EMAIL?: string;
  WRANGLER_CONFIG_DIR?: string;
  XDG_CONFIG_HOME?: string;
  UNSELF_WRANGLER_BIN?: string;
  [k: string]: string | undefined;
}

/** 子进程执行器形状（node:child_process execFile 的 promise 化子集）。 */
export type ExecFileLike = (
  cmd: string,
  args: string[],
  opts?: { env?: AuthEnv },
) => Promise<{ stdout: string; stderr: string }>;

/** resolveAuth 注入面（决策 #67：平台触点全部参数化）。 */
export interface ResolveAuthOptions {
  env?: AuthEnv;
  /** wrangler 可执行入口；缺省探测（UNSELF_WRANGLER_BIN > node_modules 布局 > PATH 上的 `wrangler`）；空串 = 显式跳过 OAuth。 */
  wranglerBin?: string | null;
  /** 注入 spawn（测试替身；生产 = execFileAsync）。 */
  execFile?: ExecFileLike;
  /** 平台分支参数（缺省 = 本机 process.platform / os.homedir()；只用于人话提示配置目录）。 */
  platform?: PlatformId;
  homedir?: string;
  /** 日志（人话进度；不含 token 值）。 */
  log?: (msg: string) => void;
  /** 是否做版本探测（默认 true；测试可关）。 */
  probe?: boolean;
}

/** 凭证缺失（不回落、不静默——调用方应展示 credentialsMissingMessage() 后终止）。 */
export class CredentialsMissingError extends Error {
  constructor(message = credentialsMissingMessage()) {
    super(message);
    this.name = 'CredentialsMissingError';
  }
}

/** 无凭证可用人话（API Token 路径；不做已注册自有 OAuth 应用——本阶段边界）。 */
export function credentialsMissingMessage(): string {
  return [
    '未找到可用的 Cloudflare 凭证。两条路：',
    '  ① 已装 wrangler：跑一次 `wrangler login` 完成浏览器授权（本工具借用其 OAuth 令牌，官方支持 "for use with other tools and scripts"）；',
    '  ② 没装 wrangler（零工具链）：开 https://dash.cloudflare.com/profile/api-tokens 创建 API Token，',
    '     然后 export CLOUDFLARE_API_TOKEN=<粘贴> 重跑；Web 向导用户把 token 粘到向导①的密码框（掩码、可校验、可重试）。',
  ].join('\n');
}

/** 拆分 exec 入口：`node /path/wrangler.js` → ['node', '/path/wrangler.js']；否则单一命令。 */
function splitBin(bin: string): [string, ...string[]] {
  return bin.startsWith('node ') ? ['node', bin.slice(5)] : [bin];
}

/**
 * 解析凭证（优先级同官方）。
 * 返回 null = 无 env 凭证且 OAuth 借用不可用（未装 wrangler / 未登录 / spawn 失败）——
 * 调用方应展示 credentialsMissingMessage() 给出 API Token 深链接指引，而不是继续跑。
 */
export async function resolveAuth(opts: ResolveAuthOptions = {}): Promise<TokenSource | null> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});

  // ① CLOUDFLARE_API_TOKEN（官方第一优先）
  if (env.CLOUDFLARE_API_TOKEN) {
    log('凭证：CLOUDFLARE_API_TOKEN（环境变量）');
    return { token: env.CLOUDFLARE_API_TOKEN, source: 'env-api-token', note: 'CLOUDFLARE_API_TOKEN（环境变量）' };
  }
  // ② API key/email（官方次优先）：显式给了就不许静默滑到 OAuth——装配客户端只认 Bearer，给人话指向 API Token
  if (env.CLOUDFLARE_API_KEY || env.CLOUDFLARE_EMAIL) {
    const msg = [
      '检测到 CLOUDFLARE_API_KEY / CLOUDFLARE_EMAIL（Global Key 老式凭证）：',
      '装配器 REST 客户端只认 Bearer API Token，不支持 Global Key 直连。',
      '请到 https://dash.cloudflare.com/profile/api-tokens 创建 API Token 后 export CLOUDFLARE_API_TOKEN=<粘贴>。',
    ].join('\n');
    log(msg);
    throw new Error(msg);
  }
  // ③ OAuth：经 `wrangler auth token` 借用；wranglerBin 空串/null 为显式跳过（注入「无 wrangler」行为用）
  if (opts.wranglerBin === '' || opts.wranglerBin === null) {
    log('OAuth 借用已被显式禁用（wranglerBin 为空）：走 API Token 路径（零工具链）。');
    return null;
  }
  const bin = opts.wranglerBin ?? (findWranglerBin(env) ?? 'wrangler');
  return borrowWranglerOauth(bin, env, opts);
}

/** 内部：执行 `wrangler auth token`（含 WRANGLER_CONFIG_DIR/XDG_CONFIG_HOME 透传与版本警告）。 */
async function borrowWranglerOauth(bin: string, env: AuthEnv, opts: ResolveAuthOptions): Promise<TokenSource | null> {
  const log = opts.log ?? (() => {});
  const execFile = opts.execFile ?? execFileAsync;
  const [cmd, ...rest] = splitBin(bin);
  try {
    const { stdout } = await execFile(cmd!, ['auth', 'token', ...rest], { env });
    const token = parseWranglerTokenOutput(String(stdout ?? ''));
    if (!token) {
      log('wrangler 已安装但未取到 OAuth 令牌（未登录或会话过期）：跑一次 `wrangler login` 完成浏览器授权；或改用 API Token 路径。');
      return null;
    }
    const warning = opts.probe === false ? undefined : await probeVersionWarning(bin, env, opts.execFile);
    const cfgDir = wranglerConfigDirFor({
      env,
      platform: opts.platform ?? (osPlatform() as PlatformId),
      homedir: opts.homedir ?? osHomedir(),
    });
    log(`凭证：借用 wrangler OAuth 令牌（官方支持 "for use with other tools and scripts"；配置目录 ${cfgDir ?? '未知'}）`);
    return {
      token,
      source: 'wrangler-oauth',
      note: 'wrangler OAuth（wrangler auth token 借用）',
      ...(warning ? { warning } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`wrangler auth token 不可用（${msg.split('\n')[0]?.slice(0, 120)}）：走 API Token 路径（零工具链）。`);
    return null;
  }
}

/** 版本探测：`wrangler --version` ≠ 已验证版本（4.129.0）→ 警告行（实测依据 docs/audit/241-*）。 */
async function probeVersionWarning(bin: string, env: AuthEnv, injected?: ExecFileLike): Promise<string | undefined> {
  try {
    const execFile = injected ?? execFileAsync;
    const [cmd, ...rest] = splitBin(bin);
    const { stdout } = await execFile(cmd!, ['--version', ...rest], { env });
    return wranglerVersionWarning(parseWranglerVersionOutput(stdout)) ?? undefined;
  } catch {
    return wranglerVersionWarning(null) ?? undefined;
  }
}

/** 权限自检（permissions.ts）用的请求头：Bearer 或 X-Auth-*（Global Key），二选一。 */
export function credentialHeaders(cred: TokenSource): Record<string, string> {
  if (cred.source === 'env-api-key') {
    if (!cred.authEmail) throw new Error('env-api-key 凭证缺 authEmail（内部错误）');
    return { 'X-Auth-Email': cred.authEmail, 'X-Auth-Key': cred.token };
  }
  return { Authorization: `Bearer ${cred.token}` };
}

const execFileAsync = promisify(execFileCb) as unknown as ExecFileLike;
