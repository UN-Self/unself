// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { domainProblem } from '../../src/engine/domain';

describe('domainProblem（域名形态体检，#119③）', () => {
  it('合法域名（多级、连字符段）→ null', () => {
    expect(domainProblem('team.example.com')).toBeNull();
    expect(domainProblem('my-team.corp.example.cn')).toBeNull();
  });
  it('裸名（无点）→ 人话提示且复述输入', () => {
    const p = domainProblem('myteam');
    expect(p).toContain('myteam');
    expect(p).toContain('点');
  });
  it('空段（连续点）→ 拒绝', () => {
    expect(domainProblem('a..b')).not.toBeNull();
  });
  it('非法字符/连字符开头结尾 → 拒绝', () => {
    expect(domainProblem('a b.example.com')).not.toBeNull();
    expect(domainProblem('-a.example.com')).not.toBeNull();
    expect(domainProblem('a-.example.com')).not.toBeNull();
  });
});
