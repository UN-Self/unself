// SPDX-License-Identifier: AGPL-3.0-only
/** 域名形态规则（SPA 侧镜像 src/web/state.domainProblem；服务端仍守门，前端只做即时人话）。 */

/** 域名形态体检：至少一个点、段规则。返回 null = 合法。 */
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
