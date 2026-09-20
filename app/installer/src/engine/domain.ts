// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 域名形态体检（#119③）：装配语义的共享纯函数。
 * #303：原先住在 deploy/cloudflare/src/interactive.ts（那个文件混着 CLI 交互层，已随第二套 CLI 删掉），
 * 纯校验语义拆到本文件；使用者是九步引擎（steps.ts）与向导壳。
 */
/**
 * 域名形态体检（#119③）：返回 null = 合法；否则给一句能直接照做的人话描述。
 * 规则：至少含一个点；每段为字母/数字/连字符，连字符不开头不结尾，不许有空段。
 */
export function domainProblem(domain: string): string | null {
  const d = domain.trim();
  if (!d) return '域名为空';
  if (!d.includes('.')) return `「${d}」不像完整域名：至少要带一个点（如 team.example.com），裸名字没法配 DNS`;
  for (const label of d.split('.')) {
    if (label === '') return '域名里有连续的点（空段）';
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) {
      return `「${label}」这段不合法：每段只能用字母、数字、连字符（-），且连字符不能开头或结尾`;
    }
  }
  return null;
}
