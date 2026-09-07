// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import app from '../src/index';

describe('module-hello', () => {
  it('GET /api/health 返回 200 与预期 body', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'module-hello' });
  });

  it('manifest.yaml 含 id: hello 与 identity', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = readFileSync(join(here, '..', 'manifest.yaml'), 'utf8');
    expect(manifest).toContain('id: hello');
    expect(manifest).toContain('identity');
  });
});
