// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 发布 tag 解析的行为测试（决策 #79「tag 即版本」；W5 预期行为清单 E1–E3）。
 *
 * 被测对象是仓库根 `scripts/release/tag-to-package.mjs`（发布流水线的唯一版本来源）：
 * 不测实现，只测「给一个 tag，应该发布哪个包的哪个版本」这一可观测行为。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReleaseTag, RELEASE_TARGETS, toGithubOutput } from '../../../scripts/release/tag-to-package.mjs';
import { findRepoRoot } from './helpers/repo-root';

describe('发布 tag → 包与版本（tag 即版本）', () => {
  it('五个包各自解析出正确的包名与版本', () => {
    expect(parseReleaseTag('workbench-v0.1.1')).toMatchObject({ package: '@unself/workbench', version: '0.1.1', kind: 'workspace' });
    expect(parseReleaseTag('sdk-v0.1.0')).toMatchObject({ package: '@unself/sdk', version: '0.1.0' });
    expect(parseReleaseTag('hello-v0.1.0')).toMatchObject({ package: '@unself/hello', version: '0.1.0', id: 'hello' });
    expect(parseReleaseTag('chat-v0.1.0')).toMatchObject({ package: '@unself/chat', version: '0.1.0', id: 'chat' });
    expect(parseReleaseTag('installer-v0.2.0')).toMatchObject({ package: '@unself/installer', version: '0.2.0' });
  });

  it('四个包互不阻塞：只解析 tag 指到的那个', () => {
    expect(parseReleaseTag('chat-v1.2.3').package).toBe('@unself/chat');
  });

  it('预发布版本可用（先发 next 再转正）', () => {
    expect(parseReleaseTag('installer-v0.2.0-next.1').version).toBe('0.2.0-next.1');
  });

  it('未知前缀 → 直接失败并点名可用前缀（不静默跳过）', () => {
    expect(() => parseReleaseTag('v0.2.0')).toThrow(/不是可发布的包|形式不认识/);
    expect(() => parseReleaseTag('unknowntool-v1.0.0')).toThrow(/不是可发布的包/);
    expect(() => parseReleaseTag('hello-0.1.0')).toThrow(/形式不认识/);
    expect(() => parseReleaseTag('')).toThrow(/形式不认识/);
  });

  it('版本号不合法 → 失败（不让 npm 收到非法版本）', () => {
    expect(() => parseReleaseTag('sdk-v1.0')).toThrow(/版本号不合法/);
    expect(() => parseReleaseTag('sdk-vv1.0.0')).toThrow(/版本号不合法/);
    expect(() => parseReleaseTag('sdk-vlatest')).toThrow(/版本号不合法/);
  });

  it('CI 输出可用（GITHUB_OUTPUT 行）', () => {
    const out = toGithubOutput(parseReleaseTag('hello-v0.1.0'));
    expect(out).toContain('package=@unself/hello');
    expect(out).toContain('version=0.1.0');
    expect(out).toContain('kind=module');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('映射表与 workflow 的 tag 触发器一一对应（漏一个 = 触发得到但发布不了）', () => {
    // 相对被测脚本所在仓库根解析（vitest 的 cwd 是包目录）
    const workflow = readFileSync(join(findRepoRoot(), '.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain('id-token: write');
    const triggers = [...workflow.matchAll(/'([a-z]+)-v\*'/g)].map(match => match[1]).sort();
    expect(Object.keys(RELEASE_TARGETS).sort()).toEqual(triggers);
    // 无长期凭据：workflow 不得出现任何 npm token secret 引用
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
    expect(workflow).not.toContain('NPM_TOKEN');
    // 不重复跑测试套件（PR 阶段六步门禁已过，决策 #79）
    expect(workflow).not.toMatch(/pnpm -r test|vitest/);
    // 模块发布必须把 tag 解析出的包名传给打包器（否则官方包名落成裸 id，如 `hello`）
    expect(workflow).toContain('--name "${{ steps.rel.outputs.package }}"');
  });
});
