// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import app from '../src/index';

describe('core-api', () => {
  it('GET /api/health 返回 200 与预期 body', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'core-api' });
  });

  it('POST /api/setup/activate 返回 501 占位', async () => {
    const res = await app.request('/api/setup/activate', { method: 'POST' });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'not implemented (M0 scaffold)' });
  });
});
