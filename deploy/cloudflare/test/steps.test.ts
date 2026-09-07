// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { runNineSteps } from '../src/steps';
import type { Wrangler } from '../src/wrangler';

/**
 * 录制型 fake wrangler：以「账户状态」模拟 D1/R2/secret 的存在性，
 * 记录全部命令，供幂等（连跑两次收敛）断言。
 */
function makeFakeWrangler(options?: { existingD1?: string[]; existingBuckets?: string[]; hasSecret?: boolean }) {
  const state = {
    d1: new Set(options?.existingD1 ?? []),
    buckets: new Set(options?.existingBuckets ?? []),
    secrets: new Set<string>(options?.hasSecret ? ['JWT_PRIVATE_KEY'] : []),
    secretsPut: 0,
    commands: [] as string[],
  };
  const uuid = 'a1b2c3d4-0000-0000-0000-000000000001';
  const wrangler: Wrangler = {
    async run(args) {
      return exec(args);
    },
    async tryRun(args) {
      return exec(args);
    },
  };
  async function exec(args: string[]): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
    state.commands.push(args.join(' '));
    const [cmd, ...rest] = args;
    if (cmd === 'd1') {
      const sub = rest[0];
      if (sub === 'list') return json(listD1());
      if (sub === 'create') {
        const name = rest[1]!;
        if (state.d1.has(name)) return fail(`already exists: ${name}`);
        state.d1.add(name);
        return json([{ name, uuid }]);
      }
      // migrations apply / execute：接受一切
      return okOut('');
    }
    if (cmd === 'r2') {
      const sub = rest[0];
      if (sub === 'bucket') {
        const op = rest[1];
        if (op === 'list') return json([...state.buckets].map((name) => ({ name })));
        if (op === 'create') {
          const name = rest[2]!;
          if (state.buckets.has(name)) return fail(`bucket exists: ${name}`);
          state.buckets.add(name);
          return okOut('');
        }
      }
    }
    if (cmd === 'secret') {
      const sub = rest[0];
      if (sub === 'list') return json([...state.secrets].map((name) => ({ name })));
      if (sub === 'put') {
        state.secrets.add('JWT_PRIVATE_KEY');
        state.secretsPut++;
        return okOut('Success');
      }
    }
    if (cmd === 'deploy') {
      return okOut('Deployed unself-worker https://unself-core-api.test-subdomain.workers.dev');
    }
    return okOut('');
  }
  const listD1 = () => [...state.d1].map((name) => ({ name, uuid }));
  const json = (value: unknown) => ({ ok: true, code: 0, stdout: JSON.stringify(value), stderr: '' });
  const okOut = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' });
  const fail = (stderr: string) => ({ ok: false, code: 1, stdout: '', stderr });
  return { wrangler, state };
}

/** 步骤依赖的最小仓库现场（真实文件布局：modules/hello、services/core-api、apps/shell）。 */
const ROOT = new URL('../../..', import.meta.url).pathname;

const SMOKE_OK = {
  setupToken: async () => ({ token: 't', setupUrl: '/setup?token=t' }),
  smoke: async (b: string, ids: string[]) =>
    ([{ name: 'core-api', url: `${b}/api/health`, ok: true, status: 200 }] as Array<{
      name: string;
      url: string;
      ok: boolean;
      status: number;
    }>).concat(
      ids.map((id) => ({ name: `module:${id}`, url: `${b}/m/${id}/api/health`, ok: true, status: 200 })),
    ),
};

describe('runNineSteps（九步编排 · 幂等收敛）', () => {
  it('空账号首跑：命令序列覆盖九步；二跑零 create/put（收敛）', async () => {
    const first = makeFakeWrangler();
    const summary1 = await runNineSteps({
      rootDir: ROOT,
      wrangler: first.wrangler,
      http: SMOKE_OK,
      resolveBaseUrl: async () => 'https://unself-core-api.test-subdomain.workers.dev',
      putSecret: async (workerName) => {
        first.state.secrets.add('JWT_PRIVATE_KEY');
        first.state.secretsPut++;
        first.state.commands.push(`secret put JWT_PRIVATE_KEY --name ${workerName}`);
      },
    });
    expect(summary1.baseUrl).toBe('https://unself-core-api.test-subdomain.workers.dev');
    // 首跑：两 D1 create + secret put 一次 + registry upsert hello
    expect(first.state.commands.some((c) => c.startsWith('d1 create unself-core'))).toBe(true);
    expect(first.state.commands.some((c) => c.startsWith('d1 create unself-modules'))).toBe(true);
    expect(first.state.secretsPut).toBe(1);
    expect(first.state.commands.some((c) => c.includes("VALUES 'hello'") || c.includes('module_registry'))).toBe(true);

    // 二跑（同一 fake 账户状态延续）
    const second = makeFakeWrangler({
      existingD1: ['unself-core', 'unself-modules'],
      existingBuckets: ['unself-storage'],
      hasSecret: true,
    });
    const summary2 = await runNineSteps({
      rootDir: ROOT,
      wrangler: second.wrangler,
      http: SMOKE_OK,
      resolveBaseUrl: async () => summary1.baseUrl,
    });
    // 收敛：零创建、零 secret 重写、registry 仍 upsert（终态一致）
    expect(second.state.commands.some((c) => c.startsWith('d1 create'))).toBe(false);
    expect(second.state.commands.some((c) => c.startsWith('r2 bucket create'))).toBe(false);
    expect(second.state.secretsPut).toBe(0);
    expect(second.state.commands.some((c) => c.includes('module_registry'))).toBe(true);
    expect(summary2.setup).toEqual(summary1.setup);
    expect(summary2.keypairAction).toBe('existing');
    expect(summary1.keypairAction).toBe('created');
  });

  it('九步顺序：D1→迁移→deploy→registry→R2→（⑦无命令）→HTTP ⑧⑨', async () => {
    const fake = makeFakeWrangler({
      existingD1: ['unself-core', 'unself-modules'],
      hasSecret: true,
    });
    await runNineSteps({
      rootDir: ROOT,
      wrangler: fake.wrangler,
      http: SMOKE_OK,
      resolveBaseUrl: async () => 'https://x.example',
    });
    const cmds = fake.state.commands;
    const idxOf = (re: RegExp) => cmds.findIndex((c) => re.test(c));
    expect(idxOf(/^d1 migrations apply CORE_DB/)).toBeGreaterThan(idxOf(/^d1 list/));
    expect(idxOf(/^d1 migrations apply MODULES_DB/)).toBeGreaterThan(idxOf(/^d1 migrations apply CORE_DB/));
    expect(idxOf(/^deploy/)).toBeGreaterThan(idxOf(/^d1 migrations apply MODULES_DB/));
    expect(idxOf(/module_registry/)).toBeGreaterThan(idxOf(/^deploy/));
    expect(idxOf(/^r2 bucket create unself-storage/)).toBeGreaterThan(idxOf(/module_registry/));
    // registry 终态：只 upsert hello（未选模块集为空时不产生 disable）
    expect(cmds.filter((c) => c.includes('UPDATE module_registry'))).toHaveLength(0);
  });

  it('冒烟失败 → 明确报错非零语义', async () => {
    const fake = makeFakeWrangler({ existingD1: ['unself-core', 'unself-modules'], hasSecret: true });
    await expect(
      runNineSteps({
        rootDir: ROOT,
        wrangler: fake.wrangler,
        http: {
          setupToken: SMOKE_OK.setupToken,
          smoke: async () => [{ name: 'core-api', url: 'x', ok: false, status: 503, detail: 'HTTP 503' }],
        },
        resolveBaseUrl: async () => 'https://x.example',
      }),
    ).rejects.toThrow(/冒烟失败/);
  });

  it('setup 已封死（409）→ 摘要记录 sealed 且不失败', async () => {
    const fake = makeFakeWrangler({ existingD1: ['unself-core', 'unself-modules'], hasSecret: true });
    const summary = await runNineSteps({
      rootDir: ROOT,
      wrangler: fake.wrangler,
      http: { setupToken: async () => ({ sealed: true }), smoke: SMOKE_OK.smoke },
      resolveBaseUrl: async () => 'https://x.example',
    });
    expect(summary.setup).toEqual({ sealed: true });
  });
});
