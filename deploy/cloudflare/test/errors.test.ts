// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { advise, formatAdvice } from '../src/errors';

describe('advise（已知失败 → 三要素）', () => {
  it('10405 → token 权限 + 深链接重建', () => {
    const a = advise(new Error('wrangler 命令失败\n  stderr: [code: 10405] Authentication error'));
    expect(a.owner).toBe('token');
    expect(a.cause).toContain('10405');
    expect(a.fix).toContain('深链接');
    expect(a.fix).toContain('重建');
  });
  it('DNS 解析失败（ENOTFOUND）→ dns + 等 60 秒重跑', () => {
    const a = advise(new Error('getaddrinfo ENOTFOUND demo.example.com'));
    expect(a.owner).toBe('dns');
    expect(a.fix).toContain('60');
    expect(a.fix).toContain('重跑');
  });
  it('Core 公钥抓取失败（DNS 未就绪语义）→ dns', () => {
    const a = advise(new Error('无法获取 Core 公钥（https://x/.well-known/jwks.json）：fetch failed'));
    expect(a.owner).toBe('dns');
  });
  it('fetch failed → 网络', () => {
    const a = advise(new TypeError('fetch failed'));
    expect(a.owner).toBe('network');
    expect(a.fix).toContain('网络');
  });
  it('缺 token → token + export 指引', () => {
    const a = advise(new Error('CLOUDFLARE_API_TOKEN 未设置'));
    expect(a.owner).toBe('token');
    expect(a.fix).toContain('export CLOUDFLARE_API_TOKEN=');
  });
  it('未知错误 → code + 幂等重跑（不硬归类外部原因）', () => {
    const a = advise(new Error('冒烟失败：module:hello（HTTP 503）'));
    expect(a.owner).toBe('code');
    expect(a.fix).toContain('幂等');
    expect(a.fix).toContain('重跑');
  });
  it('非 Error 值也能映射', () => {
    expect(advise('boom').owner).toBe('code');
    expect(advise(undefined).owner).toBe('code');
  });
});

describe('formatAdvice（三要素输出行）', () => {
  it('原因/归属/修复 三行，归属人话', () => {
    const lines = formatAdvice({ cause: '10405 x', owner: 'token', fix: '重建 token' });
    expect(lines).toEqual(['  原因：10405 x', '  归属：你的 token 权限', '  修复：重建 token']);
  });
  it('owner 标签齐全', () => {
    for (const [owner, label] of [
      ['dns', 'DNS'],
      ['network', '网络'],
      ['code', '代码'],
    ] as const) {
      const lines = formatAdvice({ cause: 'x', owner, fix: 'y' });
      expect(lines[1]).toContain(label);
    }
  });
});
