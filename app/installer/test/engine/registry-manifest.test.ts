// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildManifestSnapshot } from '../../src/engine/registry';

/** 非默认值 list 形式 manifest：契约 v1 字段（#243）；未知权限词在 schema 层直接抛错。 */
const DEMO_MANIFEST = `# SPDX-License-Identifier: AGPL-3.0-only
id: demo-mod
route: /m/demo-mod
version: 1.2.3
icon: chart-bar
description: 计数器演示
runtimes:
  - worker
permissions:
  - storage
  - notify
`;

describe('buildManifestSnapshot（§5.5 快照 · list 形式 YAML · 契约 v1）', () => {
  it('permissions/runtimes 来自清单，全字段（含 description/icon/version）与清单一致', () => {
    const manifest = buildManifestSnapshot({
      manifestText: DEMO_MANIFEST,
      moduleId: 'demo-mod',
      baseUrl: 'https://team.example.com',
    });
    expect(manifest.permissions).toEqual(['storage', 'notify']);
    expect(manifest.runtimes).toEqual(['worker']);
    expect(manifest.id).toBe('demo-mod');
    expect(manifest.route).toBe('/m/demo-mod');
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.icon).toBe('chart-bar');
    expect(manifest.description).toBe('计数器演示');
    // entry 仍重写为实例 URL（§5.3 同域路径制）
    expect(manifest.entry).toBe('https://team.example.com/m/demo-mod/');
  });

  it('最小清单回退：id/route/moduleId 兜底、entry 重写、runtimes 缺失即拒（#243 必填）', () => {
    expect(() =>
      buildManifestSnapshot({
        manifestText: 'id: bare\nroute: /m/bare\nversion: 0.1.0\n',
        moduleId: 'bare',
        baseUrl: 'https://team.example.com',
      }),
    ).toThrow(/runtimes/);
  });

  it('storage 块（一层嵌套标量 + list）解析为 accepts/preferred', () => {
    const manifest = buildManifestSnapshot({
      manifestText: `id: demo-mod
runtimes:
  - worker
storage:
  accepts:
    - shared
    - dedicated
  preferred: shared
tables:
  - demo_items
`,
      moduleId: 'demo-mod',
      baseUrl: 'https://x.example',
    });
    expect(manifest.storage).toEqual({ accepts: ['shared', 'dedicated'], preferred: 'shared' });
    expect(manifest.tables).toEqual(['demo_items']);
  });

  it('list 项剥掉行尾注释、缩进无关', () => {
    const manifest = buildManifestSnapshot({
      manifestText: `id: demo-mod
runtimes:
  - worker
permissions:
  - storage # 键值存储
  - notify
`,
      moduleId: 'demo-mod',
      baseUrl: 'https://x.example',
    });
    expect(manifest.id).toBe('demo-mod');
    expect(manifest.permissions).toEqual(['storage', 'notify']);
  });
});

describe('flow 式 list 防御（#64：静默丢 → 当场报错）', () => {
  it('runtimes: [worker] flow 式直接抛错，不静默丢 permissions', () => {
    expect(() =>
      buildManifestSnapshot({
        manifestText: `id: demo-mod
route: /m/demo
entry: https://x.example/m/demo/
runtimes: [worker]
permissions: [storage]
version: 1.0.0
`,
        moduleId: 'demo-mod',
        baseUrl: 'https://x.example',
      }),
    ).toThrow(/flow 式/);
  });

  it('报错信息指明违规字段，引导改 block 式', () => {
    try {
      buildManifestSnapshot({
        manifestText: 'permissions: [storage]\n',
        moduleId: 'demo-mod',
        baseUrl: 'https://x.example',
      });
      expect.unreachable('应已抛错');
    } catch (err) {
      expect((err as Error).message).toContain('permissions');
    }
  });
});

describe('未知权限词（#243：安装时直接拒绝）', () => {
  it('词表外能力词 → schema 层抛错，不静默忽略（错误面含词表提示）', () => {
    expect(() =>
      buildManifestSnapshot({
        manifestText: `id: demo-mod
runtimes:
  - worker
permissions:
  - chat
`,
        moduleId: 'demo-mod',
        baseUrl: 'https://x.example',
      }),
    ).toThrow(/permissions/);
  });
});
