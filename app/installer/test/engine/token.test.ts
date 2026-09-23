// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { TOKEN_PERMISSION_TABLE, buildTokenDeepLink, buildTokenFirstScreen, tokenProblem } from '../../src/engine/token';

describe('tokenProblem（token 预校验，#249）', () => {
  it('40 位 base62（首位字母）→ 合法', () => {
    expect(tokenProblem('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0')).toBeNull();
    expect(tokenProblem(' v2SkoDceRewSc5RVEq0L7azPqPQ8M3NiLzTBwbbo5xc ')).toBeNull();
  });
  it('空 → 报空', () => {
    expect(tokenProblem('')).toBe('token 为空');
    expect(tokenProblem('   ')).toBe('token 为空');
  });
  it('带空格/换行 → 提示可能粘了两段', () => {
    expect(tokenProblem('Aaaa bbbb')).toContain('空格');
    expect(tokenProblem('Aaaa\nbbbb')).toContain('空格');
  });
  it('粘了邮箱 → 指认「含字母数字以外字符」', () => {
    expect(tokenProblem('me@example.com')).toContain('字母数字');
  });
  it('首位非字母（数字开头 / 下划线开头）→ 提示形态不像 CF token', () => {
    expect(tokenProblem('1aaaazzzzddddwwwwqqqqeeeerrrrttttyyyy')).toContain('40');
    expect(tokenProblem('_aaaazzzzddddwwwwqqqqeeeerrrrttttyyyy')).toContain('40');
  });
  it('长度 30–50 之外 → 提示长度异常（防少粘一段）', () => {
    expect(tokenProblem(`A${'a'.repeat(29)}`)).toBeNull(); // 30 边界
    expect(tokenProblem(`A${'a'.repeat(28)}`)).toContain('长度'); // 29 位：少粘一段
    expect(tokenProblem(`A${'a'.repeat(49)}`)).toBeNull(); // 50 边界
    expect(tokenProblem(`A${'a'.repeat(50)}`)).toContain('长度');
  });
});

describe('buildTokenDeepLink（CF 官方模板 URL 格式）', () => {
  it('参数齐全且 JSON 权限集可解码', () => {
    const url = new URL(buildTokenDeepLink());
    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/profile/api-tokens');
    expect(url.searchParams.get('accountId')).toBe('*');
    expect(url.searchParams.get('zoneId')).toBe('all');
    expect(url.searchParams.get('name')).toBe('unself-deploy');
    const perms = JSON.parse(url.searchParams.get('permissionGroupKeys')!) as Array<{ key: string; type: string }>;
    expect(perms).toEqual([
      { key: 'workers_scripts', type: 'edit' },
      { key: 'd1', type: 'edit' },
      { key: 'workers_r2', type: 'edit' },
      { key: 'workers_kv_storage', type: 'edit' },
      { key: 'workers_routes', type: 'edit' },
      { key: 'dns', type: 'edit' },
      { key: 'ssl_and_certificates', type: 'edit' },
    ]);
  });
});

describe('buildTokenFirstScreen（第一屏文案）', () => {
  it('深链接模式：链接 + 粘贴提示（TTY）', () => {
    const lines = buildTokenFirstScreen({ deepLink: 'https://dash.example/x', permissionTable: TOKEN_PERMISSION_TABLE, tty: true });
    expect(lines[0]).toBe('未检测到 CLOUDFLARE_API_TOKEN。');
    expect(lines.join('\n')).toContain('https://dash.example/x');
    expect(lines.join('\n')).toContain('粘贴');
    expect(lines.join('\n')).toContain('不落盘');
  });
  it('退化模式：权限清单表', () => {
    const lines = buildTokenFirstScreen({ deepLink: null, permissionTable: TOKEN_PERMISSION_TABLE, tty: true });
    const text = lines.join('\n');
    expect(text).toContain('profile/api-tokens/create');
    expect(text).toContain('Workers Scripts Edit');
    expect(text).toContain('SSL and Certificates Edit');
  });
  it('非 TTY：人话 + export 指引', () => {
    const lines = buildTokenFirstScreen({ deepLink: 'https://dash.example/x', permissionTable: TOKEN_PERMISSION_TABLE, tty: false });
    const text = lines.join('\n');
    expect(text).toContain('非交互终端');
    expect(text).toContain('export CLOUDFLARE_API_TOKEN=');
  });

  it('TTY：提示可 export 后重跑、粘贴仅本次有效（#119①）', () => {
    const lines = buildTokenFirstScreen({ deepLink: 'https://dash.example/x', permissionTable: TOKEN_PERMISSION_TABLE, tty: true });
    const text = lines.join('\n');
    expect(text).toContain('export CLOUDFLARE_API_TOKEN 再重跑');
    expect(text).toContain('粘贴仅本次有效');
  });
  it('非 TTY 不出现「粘贴仅本次有效」提示（那是给能粘贴的人看的）', () => {
    const lines = buildTokenFirstScreen({ deepLink: 'https://dash.example/x', permissionTable: TOKEN_PERMISSION_TABLE, tty: false });
    expect(lines.join('\n')).not.toContain('粘贴仅本次有效');
  });
});
