// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 平台差异收敛层（决策 #67）：不做 adapter、不做三平台各一份实现——
 * 平台差异全部收敛为本文件的纯函数，进程/文件系统等平台触点由调用方注入，
 * 靠注入参数在 Linux CI 上覆盖 Windows/macOS/WSL 分支（决策 #67，CI 保持 Linux）。
 * 全部函数无 I/O：同形输入必出同形输出；I/O 组合器在 auth.ts。
 */

/** 进程平台指纹（node:os/platform() 的形状子集；测试注入用）。 */
export type PlatformId = 'linux' | 'darwin' | 'win32' | 'unknown';

/** 环境变量触点形状（平台差异注入的载体；测试注入字面量即可）。 */
export interface WranglerConfigDirEnv {
  WRANGLER_CONFIG_DIR?: string;
  XDG_CONFIG_HOME?: string;
  APPDATA?: string;
}

/** wrangler 配置目录解析输入（platform + env + homedir 全注入）。 */
export interface WranglerConfigDirInput {
  env: WranglerConfigDirEnv;
  platform: PlatformId;
  homedir: string;
}

/**
 * wrangler 配置目录（实测 wrangler 4.129.0/4.129.1 布局，实测记录 issue #241）：
 * - WRANGLER_CONFIG_DIR 显式指定（wrangler 官方约定）；
 * - 否则 XDG_CONFIG_HOME/.wrangler（实测 XDG_CONFIG_HOME=/tmp/empty 时 whoami 变未登录——
 *   即 wrangler 读 $XDG_CONFIG_HOME/.wrangler/config/default.toml）；
 * - 否则 platform 分支：
 *   · win32 → %APPDATA%/.wrangler（xdg-appdirs@5 语义，wrangler 依赖树实测）；
 *   · darwin → ~/Library/Preferences/.wrangler（xdg-appdirs user_config_dir 默认）；
 *   · linux（含 WSL——WSL 就是 Linux 用户态）→ ~/.config/.wrangler；WSL 不设独立分支，
 *     WSL 差异只在「从 Windows 侧调 wrangler.exe」场景，本工具只在 Linux 侧借用。
 * 纯函数：任何分支都不做 I/O；Windows/macOS/WSL 分支在 Linux 上注入 platform/env/homedir 覆盖测绿（决策 #67）。
 */
export function wranglerConfigDirFor(input: WranglerConfigDirInput): string | null {
  const { env, platform, homedir } = input;
  if (env.WRANGLER_CONFIG_DIR) return env.WRANGLER_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return `${env.XDG_CONFIG_HOME}/.wrangler`;
  if (platform === 'win32') return env.APPDATA ? `${env.APPDATA}/.wrangler` : null;
  if (platform === 'darwin') return `${homedir}/Library/Preferences/.wrangler`;
  if (platform === 'linux') return `${homedir}/.config/.wrangler`;
  return null;
}

/** 本 issue 实测基线版本（issue #241：wrangler 4.129.0）。 */
export const VERIFIED_WRANGLER_VERSION = '4.129.0';

/** 从 `wrangler --version` 输出提取版本号（容忍装饰行如 ⛅️ wrangler 4.129.1；4.129.0/4.129.1 实测形状）。 */
export function parseWranglerVersionOutput(stdout: string): string | null {
  const m = stdout.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return m?.[1] ?? null;
}

/** 版本警告文案（≠ 基线即警告，含更高版本——覆盖面矩阵未验证；null = 无警告）。 */
export function wranglerVersionWarning(ver: string | null, verified = VERIFIED_WRANGLER_VERSION): string | null {
  if (!ver) {
    return '未取到 wrangler 版本：OAuth 覆盖矩阵只在 wrangler 4.129.0 实测过（审计 241），本次借用无法确认版本，权限覆盖以实测矩阵为准。';
  }
  if (ver !== verified) {
    return `wrangler 版本 ${ver} ≠ 已验证的 ${verified}：OAuth 覆盖矩阵（D1/R2/KV/zone 路由全过、仅 Total TLS 不可用）只在该版本实测过；版本不同覆盖面可能漂移——若装配中途报权限不足，改用 API Token 路径。`;
  }
  return null;
}
