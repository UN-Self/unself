// SPDX-License-Identifier: AGPL-3.0-only
/**
 * provision（①）与 registry（⑤）单元行为测试（#244 REST 化后）：
 * - ensureDatabases：REST 查漏补建（创建两次 / 零创建）；
 * - registry：upsert/disable 语句收敛语义（同一份 SQL 在 control-plane 各实现的测试里跑行为，
 *   这里守 SQL 字符串形状契约与 manifest 快照的确定性——wrangler 内联时代的形状回归面）。
 */
import { describe, expect, it } from 'vitest';
import { ensureDatabases } from '../../src/engine/provision';
import { registryDisableCommand, registryUpsertCommand, sqlString, buildManifestSnapshot } from '../../src/engine/registry';
import { ModuleManifestSchema } from '@unself/contracts';
import { RestClient } from '../../src/engine/rest/client';

const HELLO_MANIFEST = `# SPDX-License-Identifier: AGPL-3.0-only
id: hello
route: /m/hello
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
  const manifest = buildManifestSnapshot({ manifestText: HELLO_MANIFEST, moduleId: 'hello' });

  it('sqlString：单引号翻倍转义', () => {
    expect(sqlString("o'brien")).toBe(`'o''brien'`);
  });

  it('registryUpsertCommand：enabled=1 + manifest 快照 JSON + 落点三列（#348；U9 起 entry 列承载地址）', () => {
    const cmd = registryUpsertCommand({
      manifest: ModuleManifestSchema.parse(manifest),
      mode: 'cloudflare',
      entry: 'https://team.example.com/m/hello/',
      storage_level: 'core',
    });
    expect(cmd.binds[0]).toBe('hello');
    expect(cmd.binds[1]).toBe(1);
    expect(cmd.binds[2]).toBe('0.1.0');
    expect(JSON.parse(String(cmd.binds[3]))).toMatchObject({ id: 'hello' });
    // 落点三列（#348）：显式传参原样透传，缺省回落 cloudflare/空；entry（U9）= 装配器算的实例地址
    expect(cmd.binds[4]).toBe('cloudflare');
    expect(cmd.binds[5]).toBe('https://team.example.com/m/hello/');
    expect(cmd.binds[6]).toBe('core');
    const bare = registryUpsertCommand({ manifest: ModuleManifestSchema.parse(manifest) });
    // 合并语义（#348 review 定案）：未写三列 binds 归一 NULL（= 保留旧值），
    // 首次插入的 mode 缺省 'cloudflare' 由 SQL 内 coalesce 承载，不在 binds 里补。
    expect(bare.binds[4]).toBeNull();
    expect(bare.binds[5]).toBeNull();
    expect(bare.binds[6]).toBeNull();
    expect(cmd.sql).toContain('ON CONFLICT(id) DO UPDATE');
    expect(cmd.sql).toContain('mode, entry, storage_level');
  });

  it('registryUpsertCommand：未写三列 binds 全 NULL，SQL 冲突分支引用原始 ?N 保留旧值（#348 review）', () => {
    const bare = registryUpsertCommand({ manifest: ModuleManifestSchema.parse(manifest) });
    // #349 起 8 参形态：第 8 参 credential_hash 恒 NULL（installer 不经手凭证；首插落 NULL，冲突保留旧值）
    expect(bare.binds).toEqual(['hello', 1, '0.1.0', expect.any(String), null, null, null, null]);
    expect(bare.sql).toContain("coalesce(?5, 'cloudflare')");
    expect(bare.sql).toContain('coalesce(?5, mode)');
    expect(bare.sql).toContain("coalesce(?6, CASE WHEN coalesce(?5, mode) = 'connect' THEN entry END)");
    expect(bare.sql).toContain('coalesce(?7, storage_level)');
    expect(bare.sql).toContain('coalesce(?8, credential_hash)');
  });

  it('registryDisableCommand：只翻 enabled，不凭空建行', () => {
    expect(registryDisableCommand('hello')).toBe("UPDATE module_registry SET enabled = 0 WHERE id = 'hello'");
  });

  it('buildManifestSnapshot：快照确定性且不含地址（#349 U9：地址走 entry 列）', () => {
    expect((manifest as unknown as Record<string, unknown>).entry).toBeUndefined();
    expect(manifest.version).toBe('0.1.0');
  });
});
