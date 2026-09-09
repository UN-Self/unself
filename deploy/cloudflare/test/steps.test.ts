// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { needsTotalTls, runNineSteps } from '../src/steps';
import type { Wrangler } from '../src/wrangler';

/** 测试注入口：拦截 shell 构建（真实 vite build 约 4.4s/次，#73 每次部署都重建 → 套件必超时；写最小产物即可）。 */
async function fakeBuildShell(rootDir: string): Promise<void> {
  const dist = join(rootDir, 'apps/shell/dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<html><body>TEST SHELL</body></html>');
}

/** runNineSteps 带测试默认值的小包装（默认注入 fakeBuildShell）。 */
function runSteps(input: Parameters<typeof runNineSteps>[0]) {
  return runNineSteps({ buildShell: fakeBuildShell, ...input });
}

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
        if (op === 'list') {
          // wrangler v4 真机格式：formatLabelledValues 输出（label 对齐、桶间空行、无 --json）
          return okOut(
            [...state.buckets]
              .map(
                (name) =>
                  `name:${' '.repeat(11)}${name}\n` +
                  `creation_date:${' '.repeat(2)}Wed, 01 Jan 2025 00:00:00 GMT`,
              )
              .join('\n\n'),
          );
        }
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

/** 合法公钥 JWKS 字符串（真实 P-256 公钥 JWK 形状的静态夹具，与 core GET /.well-known/jwks.json 同形）。 */
const FIXED_JWKS = JSON.stringify({
  keys: [{
    kty: 'EC',
    crv: 'P-256',
    x: '2zYTVcy0bDXQ7qqeNDB38zsPVvwUkKZ6-m3xA1zwA2U',
    y: 'j8zUPxAyGRUAaHRNYwdU3IW7TSBI1kSrg7RmUhb8lZk',
    kid: 'RDB_5KqpPvLCvU7V6n8r6-xxpSJutKJCWNmyZWesNSg',
    use: 'sig',
    alg: 'ES256',
  }],
});

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

describe('needsTotalTls（Universal SSL 覆盖边界）', () => {
  it('一级子域：覆盖，不需要', () => {
    expect(needsTotalTls('unself.handywote.top', 'handywote.top')).toBe(false);
  });
  it('多级子域：不覆盖，需要', () => {
    expect(needsTotalTls('unself.demo.handywote.top', 'handywote.top')).toBe(true);
  });
  it('apex 自身：覆盖，不需要', () => {
    expect(needsTotalTls('handywote.top', 'handywote.top')).toBe(false);
  });
});

describe('runNineSteps（九步编排 · 幂等收敛）', () => {
  it('空账号首跑：命令序列覆盖九步；二跑零 create/put（收敛）', { timeout: 120_000 }, async () => {
    const first = makeFakeWrangler();
    const summary1 = await runSteps({
      rootDir: ROOT,
      configOverride: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
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
    const summary2 = await runSteps({
      rootDir: ROOT,
      configOverride: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      wrangler: second.wrangler,
      http: SMOKE_OK,
      resolveBaseUrl: async () => summary1.baseUrl,
      fetchJwks: async () => FIXED_JWKS,
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

  it('九步顺序：D1→迁移→deploy→registry→R2→（⑦无命令）→HTTP ⑧⑨', { timeout: 120_000 }, async () => {
    const fake = makeFakeWrangler({
      existingD1: ['unself-core', 'unself-modules'],
      hasSecret: true,
    });
    await runSteps({
      rootDir: ROOT,
      configOverride: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      wrangler: fake.wrangler,
      http: SMOKE_OK,
      resolveBaseUrl: async () => 'https://x.example',
      fetchJwks: async () => FIXED_JWKS,
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

  it('domain 设定时：core 部署后立即 ensureDns（先于 registry 与冒烟）', { timeout: 120_000 }, async () => {
    const fake = makeFakeWrangler({ existingD1: ['unself-core', 'unself-modules'], hasSecret: true });
    await runSteps({
      rootDir: ROOT,
      wrangler: fake.wrangler,
      configOverride: { domain: 'demo.handywote.top', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      resolveZone: async () => ({ id: 'zone-1', name: 'handywote.top' }),
      cleanupCustomDomains: async () => {
        fake.state.commands.push('__cleanupCustomDomains');
      },
      ensureTotalTls: async () => {
        fake.state.commands.push('__ensureTotalTls');
      },
      resolveBaseUrl: async () => 'https://demo.handywote.top',
      fetchJwks: async () => FIXED_JWKS,
      ensureDns: async (domain) => {
        fake.state.commands.push(`__ensureDns:${domain}`);
      },
    });
    const cmds = fake.state.commands;
    const idxOf = (re: RegExp) => cmds.findIndex((c) => re.test(c));
    expect(cmds.filter((c) => c.startsWith('__ensureDns'))).toEqual(['__ensureDns:demo.handywote.top']);
    expect(cmds.filter((c) => c === '__cleanupCustomDomains')).toHaveLength(1);
    expect(cmds.filter((c) => c === '__ensureTotalTls')).toHaveLength(1);
    // 顺序：Custom Domain 清理 → Total TLS → core deploy → DNS 自建 → registry
    expect(idxOf(/^__cleanupCustomDomains/)).toBeLessThan(idxOf(/^deploy/));
    expect(idxOf(/^__ensureTotalTls/)).toBeLessThan(idxOf(/^deploy/));
    expect(idxOf(/^__ensureDns/)).toBeGreaterThan(idxOf(/^deploy/));
    expect(idxOf(/^__ensureDns/)).toBeLessThan(idxOf(/module_registry/));
  });

  it('未选模块（modules: []）→ 删除其 zone 路由，注册表 disable 照旧（#77）', { timeout: 120_000 }, async () => {
    const fake = makeFakeWrangler({ existingD1: ['unself-core', 'unself-modules'], hasSecret: true });
    const routeCalls: Array<{ zoneId: string; domain: string; moduleIds: string[]; apiToken: string; hasLog: boolean }> = [];
    await runSteps({
      rootDir: ROOT,
      wrangler: fake.wrangler,
      // 零模块：modules/hello 存在但未选中 → 必须删其 zone 路由（§6.5 全停用空态可表达）
      configOverride: { domain: 'demo.handywote.top', modules: [], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      resolveZone: async () => ({ id: 'zone-1', name: 'handywote.top' }),
      cleanupCustomDomains: async () => {
        fake.state.commands.push('__cleanupCustomDomains');
      },
      ensureTotalTls: async () => {
        fake.state.commands.push('__ensureTotalTls');
      },
      cleanupModuleRoutes: async (info) => {
        routeCalls.push({
          zoneId: info.zoneId,
          domain: info.domain,
          moduleIds: info.moduleIds,
          apiToken: info.apiToken,
          hasLog: typeof info.log === 'function',
        });
        fake.state.commands.push('__cleanupModuleRoutes');
      },
      resolveBaseUrl: async () => 'https://demo.handywote.top',
      fetchJwks: async () => FIXED_JWKS,
      ensureDns: async (domain) => {
        fake.state.commands.push(`__ensureDns:${domain}`);
      },
    });
    // 删除动作：未选 hello、zone/domain 与部署期解析一致
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]).toMatchObject({
      zoneId: 'zone-1',
      domain: 'demo.handywote.top',
      moduleIds: ['hello'],
      hasLog: true,
    });
    const cmds = fake.state.commands;
    const idxOf = (re: RegExp) => cmds.findIndex((c) => re.test(c));
    // 注册表翻转照旧（not_deployed），且删除在步骤⑤之前（步骤④′）
    expect(cmds.some((c) => c.includes("UPDATE module_registry SET enabled = 0 WHERE id = 'hello'"))).toBe(true);
    expect(idxOf(/^__cleanupModuleRoutes/)).toBeLessThan(idxOf(/module_registry/));
    // 只删路由：未选模块不部署 Worker（不删 Worker/D1，也不重新上传）
    expect(cmds.some((c) => c.includes('modules/hello.wrangler.jsonc'))).toBe(false);
  });

  it('未配置 domain（workers.dev）→ 未选模块跳过路由删除（无 zone 路由）', { timeout: 120_000 }, async () => {
    const fake = makeFakeWrangler({ existingD1: ['unself-core', 'unself-modules'], hasSecret: true });
    let routeCalls = 0;
    await runSteps({
      rootDir: ROOT,
      wrangler: fake.wrangler,
      configOverride: { domain: '', modules: [], storage: { provider: 'r2', bucket: 'unself-storage' } },
      http: SMOKE_OK,
      cleanupModuleRoutes: async () => {
        routeCalls++;
      },
      resolveBaseUrl: async () => 'https://x.example',
      fetchJwks: async () => FIXED_JWKS,
    });
    expect(routeCalls).toBe(0);
    // 注册表 disable 仍照旧
    expect(fake.state.commands.some((c) => c.includes("UPDATE module_registry SET enabled = 0 WHERE id = 'hello'"))).toBe(true);
  });

  it('冒烟失败 → 明确报错非零语义', async () => {
    const fake = makeFakeWrangler({ existingD1: ['unself-core', 'unself-modules'], hasSecret: true });
    await expect(
      runSteps({
        rootDir: ROOT,
      configOverride: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
        wrangler: fake.wrangler,
        http: {
          setupToken: SMOKE_OK.setupToken,
          smoke: async () => [{ name: 'core-api', url: 'x', ok: false, status: 503, detail: 'HTTP 503' }],
        },
        resolveBaseUrl: async () => 'https://x.example',
        fetchJwks: async () => FIXED_JWKS,
      }),
    ).rejects.toThrow(/冒烟失败/);
  });

  it('setup 已封死（409）→ 摘要记录 sealed 且不失败', async () => {
    const fake = makeFakeWrangler({ existingD1: ['unself-core', 'unself-modules'], hasSecret: true });
    const summary = await runSteps({
      rootDir: ROOT,
      configOverride: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      wrangler: fake.wrangler,
      http: { setupToken: async () => ({ sealed: true }), smoke: SMOKE_OK.smoke },
      resolveBaseUrl: async () => 'https://x.example',
      fetchJwks: async () => FIXED_JWKS,
    });
    expect(summary.setup).toEqual({ sealed: true });
  });

  it('分支 A：首部署（无 secret）→ vars.CORE_JWKS_JSON 用本运行公钥，不调用 fetchJwks', { timeout: 120_000 }, async () => {
    const fake = makeFakeWrangler();
    let fetchCalls = 0;
    await runSteps({
      rootDir: ROOT,
      configOverride: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      wrangler: fake.wrangler,
      http: SMOKE_OK,
      resolveBaseUrl: async () => 'https://unself-core-api.test-subdomain.workers.dev',
      // spy：被调用即失败——分支 A 必须完全跳过公网抓取
      fetchJwks: async () => {
        fetchCalls++;
        throw new Error('分支 A 不应调用 fetchJwks');
      },
      putSecret: async (workerName) => {
        fake.state.secrets.add('JWT_PRIVATE_KEY');
        fake.state.secretsPut++;
        fake.state.commands.push(`secret put JWT_PRIVATE_KEY --name ${workerName}`);
      },
    });
    expect(fetchCalls).toBe(0);
    const cfg = JSON.parse(
      await readFile(join(ROOT, '.deploy/cloudflare/modules/hello.wrangler.jsonc'), 'utf8'),
    ) as { vars: { CORE_JWKS_JSON: string } };
    const jwks = JSON.parse(cfg.vars.CORE_JWKS_JSON) as { keys: Array<Record<string, string>> };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kty).toBe('EC');
    expect(jwks.keys[0]?.crv).toBe('P-256');
    expect(jwks.keys[0]?.kid).toBeTruthy();
    expect(jwks.keys[0]?.use).toBe('sig');
    expect(jwks.keys[0]?.alg).toBe('ES256');
  });

  it('分支 B：已有 secret → 公网抓取 JWKS 注入 vars.CORE_JWKS_JSON（fetchJwks 收到 baseUrl）', { timeout: 120_000 }, async () => {
    const fake = makeFakeWrangler({ existingD1: ['unself-core', 'unself-modules'], hasSecret: true });
    const received: string[] = [];
    await runSteps({
      rootDir: ROOT,
      configOverride: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      wrangler: fake.wrangler,
      http: SMOKE_OK,
      resolveBaseUrl: async () => 'https://unself-core-api.test-subdomain.workers.dev',
      fetchJwks: async (baseUrl) => {
        received.push(baseUrl);
        return FIXED_JWKS;
      },
    });
    expect(received).toEqual(['https://unself-core-api.test-subdomain.workers.dev']);
    const cfg = JSON.parse(
      await readFile(join(ROOT, '.deploy/cloudflare/modules/hello.wrangler.jsonc'), 'utf8'),
    ) as { vars: { CORE_JWKS_JSON: string } };
    expect(cfg.vars.CORE_JWKS_JSON).toBe(FIXED_JWKS);
  });

  it('分支 C：公网抓取失败 → 硬报错（含「无法获取 Core 公钥」与重跑提示）', async () => {
    const fake = makeFakeWrangler({ existingD1: ['unself-core', 'unself-modules'], hasSecret: true });
    await expect(
      runSteps({
        rootDir: ROOT,
        configOverride: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
        wrangler: fake.wrangler,
        http: SMOKE_OK,
        resolveBaseUrl: async () => 'https://unself-core-api.test-subdomain.workers.dev',
        fetchJwks: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow(/无法获取 Core 公钥/);
    await expect(
      runSteps({
        rootDir: ROOT,
        configOverride: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } },
        wrangler: fake.wrangler,
        http: SMOKE_OK,
        resolveBaseUrl: async () => 'https://unself-core-api.test-subdomain.workers.dev',
        fetchJwks: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow(/可重跑部署（幂等）/);
  });
});
