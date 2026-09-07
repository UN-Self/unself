// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
  ExportBundleSchema,
  HealthSchema,
  ModuleManifestSchema,
  ModuleTokenClaimsSchema,
  SdkMessageSchema,
  type ExportBundle,
  type ModuleLifecycle,
} from '../src/index';

const validManifest = {
  id: 'hello-world',
  route: '/m/hello-world',
  entry: 'https://unself.example.com/hello-world/worker.js',
  runtime: 'worker',
  requires: ['identity'],
  capabilities: ['notify'],
  version: '1.0.0',
};

describe('ModuleManifestSchema', () => {
  it('accepts a valid manifest', () => {
    const manifest = ModuleManifestSchema.parse(validManifest);
    expect(manifest.id).toBe('hello-world');
    expect(manifest.runtime).toBe('worker');
    expect(manifest.requires).toEqual(['identity']);
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

  it('rejects an invalid runtime', () => {
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, runtime: 'edge' }),
    ).toThrow();
  });

  it('rejects an out-of-spec id', () => {
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, id: 'Hello_World' }),
    ).toThrow();
  });

  it('rejects an empty requires list', () => {
    expect(() =>
      ModuleManifestSchema.parse({ ...validManifest, requires: [] }),
    ).toThrow();
  });
});

describe('ModuleTokenClaimsSchema', () => {
  it('parses claims without act/caps', () => {
    const claims = ModuleTokenClaimsSchema.parse({
      iss: 'https://core.unself.example',
      sub: 'mod-a',
      aud: 'core-api',
      iat: 1_700_000_000,
      exp: 1_800_000_000,
    });
    expect(claims.sub).toBe('mod-a');
    expect(claims.act).toBeUndefined();
  });

  it('parses claims containing act', () => {
    const claims = ModuleTokenClaimsSchema.parse({
      iss: 'https://core.unself.example',
      sub: 'mod-a',
      aud: 'core-api',
      iat: 1_700_000_000,
      exp: 1_800_000_000,
      act: { sub: 'mod-b' },
      caps: ['notify', 'navigate'],
    });
    expect(claims.act?.sub).toBe('mod-b');
    expect(claims.caps).toEqual(['notify', 'navigate']);
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
