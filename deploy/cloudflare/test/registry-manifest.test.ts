// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildManifestSnapshot } from '../src/registry';

/** 非默认值 list 形式 manifest：requires/capabilities 必须是 YAML list、capabilities 非默认 'demo'。 */
const DEMO_MANIFEST = `# SPDX-License-Identifier: AGPL-3.0-only
id: demo-mod
route: /m/demo-mod
version: 1.2.3
icon: chart-bar
description: 计数器演示
requires:
  - identity
capabilities:
  - counter
  - notify
`;

describe('buildManifestSnapshot（§5.5 快照 · list 形式 YAML）', () => {
  it('capabilities/requires 来自清单，全字段（含 description/icon/version）与清单一致', () => {
    const manifest = buildManifestSnapshot({
      manifestText: DEMO_MANIFEST,
      moduleId: 'demo-mod',
      baseUrl: 'https://team.example.com',
    });
    expect(manifest.capabilities).toEqual(['counter', 'notify']);
    expect(manifest.requires).toEqual(['identity']);
    expect(manifest.id).toBe('demo-mod');
    expect(manifest.route).toBe('/m/demo-mod');
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.icon).toBe('chart-bar');
    expect(manifest.description).toBe('计数器演示');
    // entry 仍重写为实例 URL（§5.3 同域路径制）
    expect(manifest.entry).toBe('https://team.example.com/m/demo-mod/');
  });

  it('缺失时回退：requires 默认 identity（契约 min(1)）、capabilities 默认空', () => {
    const manifest = buildManifestSnapshot({
      manifestText: 'id: bare\nroute: /m/bare\nversion: 0.1.0\n',
      moduleId: 'bare',
      baseUrl: 'https://team.example.com',
    });
    expect(manifest.requires).toEqual(['identity']);
    expect(manifest.capabilities).toEqual([]);
  });

  it('list 项剥掉行尾注释、缩进无关', () => {
    const manifest = buildManifestSnapshot({
      manifestText: `id: demo-mod # 演示模块
capabilities:
  - counter # 加计数
  - notify
`,
      moduleId: 'demo-mod',
      baseUrl: 'https://x.example',
    });
    expect(manifest.id).toBe('demo-mod');
    expect(manifest.capabilities).toEqual(['counter', 'notify']);
  });
});
