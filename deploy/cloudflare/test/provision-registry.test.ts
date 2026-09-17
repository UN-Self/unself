// SPDX-License-Identifier: AGPL-3.0-only
/**
 * provision（①）与 registry（⑤）单元行为测试（#244 REST 化后）：
 * - ensureDatabases：REST 查漏补建（创建两次 / 零创建）；
 * - registry：upsert/disable 语句收敛语义（同一份 SQL 在 control-plane 各实现的测试里跑行为，
 *   这里守 SQL 字符串形状契约与 manifest 快照的确定性——wrangler 内联时代的形状回归面）。
 */
import { describe, expect, it } from 'vitest';
import { ensureDatabases } from '../src/provision';
import { registryDisableCommand, registryUpsertCommand, sqlString, buildManifestSnapshot } from '../src/registry';
import { ModuleManifestSchema } from '@unself/contracts';
import { RestClient } from '../src/rest/client';

const HELLO_MANIFEST = `# SPDX-License-Identifier: AGPL-3.0-only
id: hello
route: /m/hello
entry: http://localhost:8790/ # 占位
runtimes:
  - worker
permissions:
  - storage
version: 0.1.0
`;

describe('ensureDatabases（①幂等 · REST）', () => {
  it('两库都不存在 → 创建两次；都存在 → 零创建', async () => {
    const uuid = 'a1b2c3d4-0000-0000-0000-000000000001';
    const calls: Array<{ method: string; url: string }> = [];
    const mk = (existing: string[]): RestClient =>
      new RestClient({
        token: 't',
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? 'GET';
          calls.push({ method, url });
          const env = (result: unknown) =>
            new Response(JSON.stringify({ success: true, result, errors: [] }), { status: 200 });
          if (url.endsWith('/d1/database') && method === 'GET') {
            return env(existing.map((name) => ({ name, uuid })));
          }
          if (url.endsWith('/d1/database') && method === 'POST') {
            const name = JSON.parse(String(init?.body)).name as string;
            return env({ name, uuid });
          }
          return env(null);
        }) as typeof fetch,
      });

    const empty = await ensureDatabases(mk([]), 'ACC');
    expect(empty.core).toBe(uuid);
    expect(empty.modules).toBe(uuid);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);

    calls.length = 0;
    const existing = await ensureDatabases(mk(['unself-core', 'unself-modules']), 'ACC');
    expect(existing.modules).toBe(uuid);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('registry（⑤ · 形状契约）', () => {
  const manifest = buildManifestSnapshot({ manifestText: HELLO_MANIFEST, moduleId: 'hello', baseUrl: 'https://team.example.com' });

  it('sqlString：单引号翻倍转义', () => {
    expect(sqlString("o'brien")).toBe(`'o''brien'`);
  });

  it('registryUpsertCommand：enabled=1 + manifest 快照 JSON（upsert 语义随 ControlPlane 跑行为）', () => {
    const cmd = registryUpsertCommand({ manifest: ModuleManifestSchema.parse(manifest) });
    expect(cmd.binds[0]).toBe('hello');
    expect(cmd.binds[1]).toBe(1);
    expect(cmd.binds[2]).toBe('0.1.0');
    expect(JSON.parse(String(cmd.binds[3]))).toMatchObject({ id: 'hello' });
    expect(cmd.sql).toContain('ON CONFLICT(id) DO UPDATE');
  });

  it('registryDisableCommand：只翻 enabled，不凭空建行', () => {
    expect(registryDisableCommand('hello')).toBe("UPDATE module_registry SET enabled = 0 WHERE id = 'hello'");
  });

  it('buildManifestSnapshot：entry 重写为实例 URL（确定性）', () => {
    expect(manifest.entry).toBe('https://team.example.com/m/hello/');
    expect(manifest.version).toBe('0.1.0');
  });
});
