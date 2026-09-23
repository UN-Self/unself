// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 构建身份解析的行为测试（#287，决策 #80）。
 *
 * 测的是「commit 从哪来」这条规则本身：CI（GITHUB_SHA）与本地（git）两条来源都要覆盖，
 * 两条都拿不到**必须红**——「未知版本」比「假版本」危险，绝不能静默留空。
 */
import { describe, expect, it } from 'vitest';

import { createBuildInfo, parseBuildInfo, resolveBuildCommit } from '../src/build-info';

const SHA_A = '7e511f6a00d2ebe57a5069a5624a3c9eceff3da6';
const SHA_B = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';

describe('resolveBuildCommit：来源优先级', () => {
  it('GITHUB_SHA 命中时优先用它（不碰 git）', () => {
    let gitCalled = false;
    const commit = resolveBuildCommit({
      env: { GITHUB_SHA: SHA_A },
      git: () => {
        gitCalled = true;
        return '0000000000000000000000000000000000000000';
      },
    });
    expect(commit).toBe(SHA_A);
    expect(gitCalled).toBe(false);
  });

  it('GITHUB_SHA 缺失时回落 git rev-parse', () => {
    expect(resolveBuildCommit({ env: {}, git: () => `${SHA_A}\n` })).toBe(SHA_A);
  });

  it('大小写变体归一到小写（GITHUB_SHA 与 git 输出同一口径）', () => {
    expect(resolveBuildCommit({ env: { GITHUB_SHA: SHA_B } })).toBe(SHA_B.toLowerCase());
    expect(resolveBuildCommit({ env: {}, git: () => `${SHA_B}\n` })).toBe(SHA_B.toLowerCase());
  });

  it('GITHUB_SHA 形状不可信（短/非十六进制）时落到 git，而不是把垃圾当版本', () => {
    expect(resolveBuildCommit({ env: { GITHUB_SHA: 'abc123' }, git: () => SHA_A })).toBe(SHA_A);
    expect(resolveBuildCommit({ env: { GITHUB_SHA: 'not-a-sha' }, git: () => SHA_A })).toBe(SHA_A);
  });

  it('两条来源都拿不到 → 抛错（禁止伪造/空 SHA）', () => {
    expect(() => resolveBuildCommit({ env: {} })).toThrow(/拿不到构建 commit/);
  });

  it('git 返回非 SHA → 抛错并点名截断值', () => {
    expect(() => resolveBuildCommit({ env: {}, git: () => 'HEAD\n' })).toThrow(/不是 40 位十六进制 SHA/);
  });
});

describe('createBuildInfo / parseBuildInfo：载荷往返与负例', () => {
  const valid = { package: '@unself/workbench', version: '0.1.1', commit: SHA_A, builtAt: '2026-09-20T00:00:00.000Z' };

  it('合法载荷往返一致', () => {
    const info = createBuildInfo(valid);
    expect(parseBuildInfo(JSON.stringify(info))).toEqual(info);
  });

  it('commit 非小写时归一到小写', () => {
    expect(createBuildInfo({ ...valid, commit: SHA_B }).commit).toBe(SHA_B.toLowerCase());
    expect(parseBuildInfo(JSON.stringify({ ...valid, commit: SHA_B })).commit).toBe(SHA_B.toLowerCase());
  });

  it('commit 缺失 / 空串 / 形状不对 → 抛错（不是静默放行）', () => {
    const { commit: _omit, ...withoutCommit } = valid;
    expect(() => parseBuildInfo(JSON.stringify(withoutCommit))).toThrow(/build-info\.json 校验失败/);
    expect(() => parseBuildInfo(JSON.stringify({ ...valid, commit: '' }))).toThrow(/build-info\.json 校验失败/);
    expect(() => parseBuildInfo(JSON.stringify({ ...valid, commit: 'deadbeef' }))).toThrow(/build-info\.json 校验失败/);
  });

  it('version 缺失 → 抛错', () => {
    const { version: _omit, ...withoutVersion } = valid;
    expect(() => parseBuildInfo(JSON.stringify(withoutVersion))).toThrow(/build-info\.json 校验失败/);
  });

  it('非法 JSON → 抛错（不返回半成品）', () => {
    expect(() => parseBuildInfo('{ not json')).toThrow(/不是合法 JSON/);
  });
});
