// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ensureDatabases, parseD1List } from '../src/provision';
import { registryCommands, registryDisableCommand, registryUpsertCommand, sqlString } from '../src/registry';
import { buildManifestSnapshot } from '../src/registry';
import { ModuleManifestSchema } from '@unself/contracts';

const HELLO_MANIFEST = `# SPDX-License-Identifier: AGPL-3.0-only
id: hello
route: /m/hello
entry: http://localhost:8790/ # 占位
runtime: worker
requires:
  - identity
capabilities:
  - demo
version: 0.1.0
`;

describe('parseD1List', () => {
  it('解析 JSON 数组输出', () => {
    const rows = parseD1List('[{"name":"unself-core","uuid":"a1b2c3d4-0000-0000-0000-000000000001"}]');
    expect(rows).toEqual([{ name: 'unself-core', uuid: 'a1b2c3d4-0000-0000-0000-000000000001' }]);
  });
  it('空输出 → 空数组', () => {
    expect(parseD1List('')).toEqual([]);
  });
});

describe('ensureDatabases（①幂等）', () => {
  it('两库都不存在 → 创建两次；都存在 → 零创建', async () => {
    const uuid = 'a1b2c3d4-0000-0000-0000-000000000001';
    const calls: string[][] = [];
    const mk = (listOut: string) => ({
      tryRun: async (args: string[]) => {
        calls.push(['try', ...args]);
        return { ok: true, code: 0, stdout: listOut, stderr: '' };
      },
      run: async (args: string[]) => {
        calls.push(['run', ...args]);
        return { ok: true, code: 0, stdout: `[{"name":"${args[2]}","uuid":"${uuid}"}]`, stderr: '' };
      },
    });

    const empty = await ensureDatabases(mk('') as never);
    expect(empty.core).toBe(uuid);
    expect(calls.filter((c) => c[0] === 'run' && c.includes('create'))).toHaveLength(2);

    calls.length = 0;
    const existing = await ensureDatabases(
      mk(`[{"name":"unself-core","uuid":"${uuid}"},{"name":"unself-modules","uuid":"${uuid}"}]`) as never,
    );
    expect(existing.modules).toBe(uuid);
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(0);
  });
});

describe('registry（⑤）', () => {
  it('manifest 快照：entry 重写为实例 URL、schema 校验通过', () => {
    const manifest = buildManifestSnapshot({
      manifestText: HELLO_MANIFEST,
      moduleId: 'hello',
      baseUrl: 'https://team.example.com',
    });
    expect(manifest.entry).toBe('https://team.example.com/m/hello/');
    expect(manifest.id).toBe('hello');
    expect(manifest.route).toBe('/m/hello');
    expect(() => ModuleManifestSchema.parse(manifest)).not.toThrow();
  });

  it('sqlString 转义单引号', () => {
    expect(sqlString("it's")).toBe("'it''s'");
  });

  it('upsert 命令带 manifest JSON binds；manifest 含引号不破坏 SQL（bind 参数化）', () => {
    const manifest = buildManifestSnapshot({
      manifestText: HELLO_MANIFEST.replace('id: hello', "id: hello # it's"),
      moduleId: 'hello',
      baseUrl: 'https://x.example',
    });
    const cmd = registryUpsertCommand({ manifest });
    expect(cmd.binds).toEqual([manifest.id, 1, manifest.version, JSON.stringify(manifest)]);
    // binds 数组参数化 → 值不进 SQL 文本
    expect(cmd.sql).not.toContain("it's");
  });

  it('registryCommands：选中 upsert + 未选 disable，顺序确定', () => {
    const commands = registryCommands({
      config: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'b' } },
      modules: [
        { id: 'hello', dir: '/m/hello', selected: true },
        { id: 'docs', dir: '/m/docs', selected: false },
      ],
      baseUrl: 'https://team.example.com',
      manifestTexts: { hello: HELLO_MANIFEST },
    });
    expect(commands.map((c) => c.kind)).toEqual(['upsert', 'disable']);
    expect(commands[0]!.sql).toContain('ON CONFLICT(id) DO UPDATE');
    expect(commands[1]!.sql).toBe(registryDisableCommand('docs'));
  });
});
