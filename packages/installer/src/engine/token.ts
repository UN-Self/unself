// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CF API Token 的共享语义（#249 预校验 / 深链接预选权限 / 权限清单表 / 第一屏文案）。
 * #303：从 deploy/cloudflare/src/interactive.ts 拆出（那里混着 TTY 交互层与参数解析，已随第二套 CLI 删掉）。
 * 注意：向导① 此前只有通用 token 页链接、文案却写「权限已预选」——本文件就是那个「预选」的真实现。
 */
/**
 * token 预校验（#249）：粘贴后先做形态检查再出网，无效直接重问。
 * CF API Token 形态 = 40 字符 base62（首位字母）——官方文档与实测 token 均如此。
 * 只拦「明显不对」（少粘一段/带空格/粘了邮箱），不断言合法性：真伪以 CF 校验为准。
 */
export function tokenProblem(token: string): string | null {
  const t = token.trim();
  if (!t) return 'token 为空';
  if (/\s/.test(t)) return 'token 里含空格/换行：可能是复制带了空白或粘了两段，请重新整段复制粘贴';
  if (!/^[A-Za-z0-9_-]+$/.test(t)) return 'token 含字母数字以外的字符：请确认复制的是 API Token 本身（不是邮箱/Notation/密钥 JSON）';
  if (!/^[A-Za-z]/.test(t)) return 'token 形态不像 CF API Token（应以字母开头的 40 位字母数字）：请确认复制完整';
  if (t.length < 30 || t.length > 50) return `token 长度 ${t.length} 不像 CF API Token（应为 40 位左右）：请确认复制完整（现少粘或多粘）`;
  return null;
}

/** CF token 深链接（官方模板 URL 格式，硬编码权限集，§5.5 ①）。 */
const TOKEN_PERMISSIONS = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'd1', type: 'edit' },
  { key: 'workers_r2', type: 'edit' },
  { key: 'workers_routes', type: 'edit' },
  { key: 'dns', type: 'edit' },
  { key: 'ssl_and_certificates', type: 'edit' },
] as const;

export function buildTokenDeepLink(name = 'unself-deploy'): string {
  const url = new URL('https://dash.cloudflare.com/profile/api-tokens');
  url.searchParams.set('permissionGroupKeys', JSON.stringify(TOKEN_PERMISSIONS));
  url.searchParams.set('accountId', '*');
  url.searchParams.set('zoneId', 'all');
  url.searchParams.set('name', name);
  return url.toString();
}

/** 权限清单表（深链接格式失效时的退化输出，也与 README 权限清单对齐）。 */
export const TOKEN_PERMISSION_TABLE: string[] = [
  '  Account：Workers Scripts Edit、D1 Edit、R2 Edit',
  '  Zone（自有域名所属 zone）：Workers Routes Edit、DNS Edit、SSL and Certificates Edit',
];

/**
 * token 第一屏文案（不打印，返回行数组；对齐 docs/deploy.md 第一步样例）。
 * deepLink 传 null = 退化打印权限清单表。
 */
export function buildTokenFirstScreen(input: { deepLink: string | null; permissionTable: string[]; tty: boolean }): string[] {
  const { deepLink, permissionTable, tty } = input;
  const lines: string[] = [];
  lines.push('未检测到 CLOUDFLARE_API_TOKEN。');
  lines.push('需要一个 Cloudflare API Token（权限已为你预选，只需点两次）：');
  if (deepLink) {
    lines.push(`  ① 打开 ${deepLink}`);
  } else {
    lines.push('  ① 打开 https://dash.cloudflare.com/profile/api-tokens/create → Create Custom Token，按下面清单勾权限：');
    lines.push(...permissionTable);
  }
  lines.push('  ② 起名（如 unself-deploy）→ Continue → Create Token → 复制');
  lines.push('  ③ 重跑：export CLOUDFLARE_API_TOKEN=<粘贴> && npx @unself/installer deploy');
  lines.push(tty ? '或直接把 token 粘贴到下面回车继续（只留在本次进程内存，不落盘）：' : '非交互终端无法粘贴 token：请先 export CLOUDFLARE_API_TOKEN=... 后重跑。');
  if (tty) lines.push('也可先 export CLOUDFLARE_API_TOKEN 再重跑（之后不用每次粘贴），粘贴仅本次有效。');
  return lines;
}
