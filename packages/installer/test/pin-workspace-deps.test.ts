// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 发布前改写 `workspace:` 协议的行为测试（issue #286；决策 #79）。
 *
 * 被测行为：`npm publish` 不改写 workspace:（pnpm publish 才会），若原样发布，
 * 消费者会得到 Unsupported URL Type "workspace:" —— 官方模块预装直接失效。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  pinWorkspaceDeps,
  rewriteWorkspaceSpec,
} from '../../../scripts/release/pin-workspace-deps.mjs';

const versions: Record<string, string> = { '@unself/sdk': '0.1.0', '@unself/hello': '0.1.0' };
const resolve = (name: string) => versions[name];

describe('发布前改写 workspace: 协议', () => {
  it('workspace:* → 精确版本；^ / ~ → 带前缀；显式 range 原样', () => {
    expect(rewriteWorkspaceSpec('workspace:*', '0.1.0')).toBe('0.1.0');
    expect(rewriteWorkspaceSpec('workspace:^', '0.1.0')).toBe('^0.1.0');
    expect(rewriteWorkspaceSpec('workspace:~', '0.1.0')).toBe('~0.1.0');
    expect(rewriteWorkspaceSpec('workspace:^1.2.3', '0.1.0')).toBe('^1.2.3');
  });

  it('非 workspace 协议一律不动（jose 等普通依赖保持原样）', () => {
    expect(rewriteWorkspaceSpec('^6.1.0', '0.1.0')).toBe('^6.1.0');
  });

  it('dependencies / devDependencies 里的 workspace: 都被改写，并记录变更', () => {
    const { pkg, changed } = pinWorkspaceDeps(
      {
        name: '@unself/installer',
        dependencies: { '@unself/hello': 'workspace:*', jose: '^6.1.0' },
        devDependencies: { '@unself/sdk': 'workspace:*' },
      },
      resolve,
    );
    expect((pkg.dependencies as Record<string, string>)['@unself/hello']).toBe('0.1.0');
    expect((pkg.dependencies as Record<string, string>).jose).toBe('^6.1.0');
    expect((pkg.devDependencies as Record<string, string>)['@unself/sdk']).toBe('0.1.0');
    expect(changed).toHaveLength(2);
  });

  it('找不到本地版本 → 人话报错（不静默发一个坏包）', () => {
    expect(() => pinWorkspaceDeps({ dependencies: { '@unself/ghost': 'workspace:*' } }, resolve)).toThrow(
      /找不到它的版本/,
    );
  });

  it('CI 接线不变量：release.yml 必须在 npm publish 之前跑 pin 脚本', () => {
    const wf = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');
    const pin = wf.indexOf('pin-workspace-deps.mjs');
    const pub = wf.indexOf('npm publish --access public');
    expect(pin).toBeGreaterThan(-1);
    expect(pub).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(pub);
  });
});
