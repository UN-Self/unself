// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
  HealthSchema,
  ModuleManifestSchema,
  ModuleTokenClaimsSchema,
  SdkMessageSchema,
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
