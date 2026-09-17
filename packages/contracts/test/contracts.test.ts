// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
  compareContractVersion,
  CONTRACT_VERSION,
  ExportBundleSchema,
  HealthSchema,
  type ModuleManifest,
  ModuleManifestSchema,
  MODULE_PERMISSIONS,
  ModulePermissionSchema,
  ModuleTokenClaimsSchema,
  SdkMessageSchema,
  type ExportBundle,
  type ModuleLifecycle,
} from '../src/index';

const validManifest: ModuleManifest = {
  id: 'hello-world',
  route: '/m/hello-world',
  entry: 'https://unself.example.com/hello-world/worker.js',
  runtimes: ['worker'],
  version: '1.0.0',
};

describe('契约版本与词表（决策 #57/#56）', () => {
  it('CONTRACT_VERSION 与 docs/modules.md §3 定稿一致', () => {
    expect(CONTRACT_VERSION).toBe('1.0');
  });

  it('MODULE_PERMISSIONS 首版词表六项、次序冻结', () => {
    expect(MODULE_PERMISSIONS).toEqual(['storage', 'acl', 'notify', 'ai', 'realtime', 'mail']);
  });

  it('ModulePermissionSchema 拒绝词表外的值（未知能力安装时拒绝，不静默忽略）', () => {
    expect(() => ModulePermissionSchema.parse('chat')).toThrow();
    expect(() => ModulePermissionSchema.parse('demo')).toThrow();
    expect(ModulePermissionSchema.parse('storage')).toBe('storage');
  });

  it('compareContractVersion 语义正确（x.y 比较，非字符串字典序）', () => {
    expect(compareContractVersion('1.0', '1.0')).toBe(0);
    expect(compareContractVersion('0.9', '1.0')).toBeLessThan(0);
    expect(compareContractVersion('1.10', '1.9')).toBeGreaterThan(0);
  });
});

describe('ModuleManifestSchema（契约 v1 字段冻结）', () => {
  it('accepts a valid manifest', () => {
    const manifest = ModuleManifestSchema.parse(validManifest);
    expect(manifest.id).toBe('hello-world');
    expect(manifest.runtimes).toEqual(['worker']);
  });

  it('accepts an optional description', () => {
    const manifest = ModuleManifestSchema.parse({
      ...validManifest,
      description: 'hello world 模块',
    });
    expect(manifest.description).toBe('hello world 模块');
  });

  it('accepts a manifest with an icon (Lucide name)', () => {
    const manifest = ModuleManifestSchema.parse({ ...validManifest, icon: 'inbox' });
    expect(manifest.icon).toBe('inbox');
  });

  it('accepts a manifest without an icon (缺省合法，壳回退模块名首字)', () => {
    const parsed = ModuleManifestSchema.parse(validManifest);
    expect(parsed.icon).toBeUndefined();
  });

  it('rejects an emoji icon (§5.1 用户拍板拒绝 emoji)', () => {
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, icon: '📨' }),
    ).toThrow();
  });

  it('rejects an icon outside [a-z0-9-] (大写/下划线/中文)', () => {
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, icon: 'Inbox' }),
    ).toThrow();
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, icon: 'mail_inbox' }),
    ).toThrow();
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, icon: '收件箱' }),
    ).toThrow();
  });

  it('rejects a route not starting with /m/', () => {
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, route: '/api/hello-world' }),
    ).toThrow();
  });

  it('rejects an invalid runtime word', () => {
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, runtimes: ['edge'] }),
    ).toThrow();
  });

  it('rejects an empty runtimes list', () => {
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, runtimes: [] }),
    ).toThrow();
  });

  it('rejects an out-of-spec id', () => {
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, id: 'Hello_World' }),
    ).toThrow();
  });

  it('rejects a single-item permission outside the vocabulary (未知权限 schema 层直接拒绝)', () => {
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, permissions: ['chat'] }),
    ).toThrow();
  });

  it('accepts declared vocabulary permissions', () => {
    const manifest = ModuleManifestSchema.parse({
      ...validManifest,
      permissions: ['storage', 'notify'],
    });
    expect(manifest.permissions).toEqual(['storage', 'notify']);
  });

  it('shared 护栏：storage.accepts 含 shared 必须申报 tables', () => {
    expect(() =>
      ModuleManifestSchema.parse({
        ...validManifest,
        storage: { accepts: ['shared'] },
      }),
    ).toThrow(/tables/);
  });

  it('preferred 不在 accepts 内 → 拒绝', () => {
    expect(() =>
      ModuleManifestSchema.parse({
        ...validManifest,
        storage: { accepts: ['dedicated'], preferred: 'shared' },
      }),
    ).toThrow(/preferred/);
  });

  it('compat.min > compat.max → 拒绝', () => {
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, compat: { min: '1.1', max: '1.0' } }),
    ).toThrow();
  });
});

describe('ModuleTokenClaimsSchema', () => {
  const baseClaims = {
    iss: 'unself-core',
    sub: 'u_1a2b3c4d',
    aud: 'mod-a',
    iat: 1_700_000_000,
    exp: 1_800_000_000,
  };

  it('parses claims without act（语义对齐实现：sub=核心用户 uid、aud=模块 id）', () => {
    const claims = ModuleTokenClaimsSchema.parse({ ...baseClaims });
    expect(claims.sub).toBe('u_1a2b3c4d');
    expect(claims.aud).toBe('mod-a');
    expect(claims.act).toBeUndefined();
  });

  it('parses claims containing act（保留契约字段，Core 未签发过）', () => {
    const claims = ModuleTokenClaimsSchema.parse({
      ...baseClaims,
      act: { sub: 'mod-b' },
    });
    expect(claims.act?.sub).toBe('mod-b');
  });

  it('accepts optional name（会话展示名；旧 token 无此字段向后兼容）', () => {
    const claims = ModuleTokenClaimsSchema.parse({ ...baseClaims, name: '黄一' });
    expect(claims.name).toBe('黄一');
  });

  it('caps claim 已删除（#56）：带 caps 的 token claims 解析时剥离、契约层不再承诺', () => {
    const claims = ModuleTokenClaimsSchema.parse({ ...baseClaims, caps: ['notify'] });
    expect('caps' in claims).toBe(false);
  });
});

describe('SdkMessageSchema', () => {
  it('parses every union member', () => {
    const messages: unknown[] = [
      { type: 'ready' },
      { type: 'token', token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' },
      { type: 'navigate', path: '/m/hello-world' },
      { type: 'notify', title: '收到新消息' },
      { type: 'notify', title: '收到新消息', body: '来自模块 A' },
      { type: 'theme', mode: 'dark' },
    ];
    for (const message of messages) {
      expect(SdkMessageSchema.parse(message).type).toBeTruthy();
    }
  });

  it('rejects an unknown union member', () => {
    expect(() =>
      SdkMessageSchema.parse({ type: 'unknown', extra: true }),
    ).toThrow();
  });
});

describe('HealthSchema', () => {
  it('parses health payload', () => {
    expect(HealthSchema.parse({ ok: true })).toEqual({ ok: true });
  });
});

describe('ExportBundleSchema', () => {
  const bundle = {
    version: 1 as const,
    moduleId: 'hello',
    exportedAt: '2026-09-07T08:00:00.000Z',
    tables: {
      hello_counter: { schemaVersion: 1, rows: [{ key: 'alice', value: 3 }] },
    },
    files: [{ key: 'hello/xx.png', size: 10, contentType: 'image/png' }],
  };

  it('parses a valid bundle', () => {
    const parsed = ExportBundleSchema.parse(bundle);
    expect(parsed.version).toBe(1);
    expect(parsed.tables.hello_counter?.schemaVersion).toBe(1);
    expect(parsed.files[0]?.key).toBe('hello/xx.png');
  });

  it('accepts an empty module (no tables, no files)', () => {
    expect(() =>
      ExportBundleSchema.parse({ ...bundle, tables: {}, files: [] }),
    ).not.toThrow();
  });

  it('rejects an unknown bundle version', () => {
    expect(() => ExportBundleSchema.parse({ ...bundle, version: 2 })).toThrow();
  });

  it('rejects a non-ISO exportedAt', () => {
    expect(() =>
      ExportBundleSchema.parse({ ...bundle, exportedAt: '2026-09-07 08:00:00' }),
    ).toThrow();
  });

  it('rejects a bad moduleId', () => {
    expect(() => ExportBundleSchema.parse({ ...bundle, moduleId: 'Hello' })).toThrow();
  });

  it('rejects a file ref with an empty key', () => {
    expect(() =>
      ExportBundleSchema.parse({ ...bundle, files: [{ key: '' }] }),
    ).toThrow();
  });
});

describe('ModuleLifecycle / ExportBundle 类型契约', () => {
  /** 类型层面：lifecycle 实现产出可过 ExportBundleSchema 校验的 bundle。 */
  const lifecycle: ModuleLifecycle = {
    async export() {
      const raw = {
        version: 1,
        moduleId: 'hello',
        exportedAt: new Date().toISOString(),
        tables: {
          hello_counter: {
            schemaVersion: 1,
            rows: [{ key: 'u-1', value: 3 }],
          },
        },
        files: [],
      };
      return ExportBundleSchema.parse(raw) satisfies ExportBundle;
    },
    async purge() {
      /* 模块自行按前缀清除 */
    },
  };

  it('export() 产出的 bundle 通过 schema 校验', async () => {
    const result = await lifecycle.export();
    expect(result.moduleId).toBe('hello');
    expect(result.version).toBe(1);
  });

  it('purge() 可等待完成', async () => {
    await expect(lifecycle.purge()).resolves.toBeUndefined();
  });
});
