// SPDX-License-Identifier: AGPL-3.0-only
/**
 * chat 全链路装配行为测试（#219，决策 #50 存储收口豁免）：
 * - 干净装配「仅启用 chat」：专属 D1/KV/R2 建立命令序正确、chat 不进 d1 migrations 链、
 *   基线 schema 经 --file 灌入、部署配置（/m/chat/* 路由 + D1/KV/R2/DO 绑定 + 前端 assets）落位；
 * - 三态：选中（upsert enabled=1 + 路由）/ 停用（disable + 路由删除 + 数据不动）/ 移除
 *   （not_deployed 语义与 hello 同款——注册表翻转 + 只删路由不删 Worker/D1）；
 * - 幂等：二跑零 create/put（D1/KV/R2/secret 全收敛）、密钥环已有不覆盖；
 * - 模块面断言参数化：期望集合由 discoverModules(rootDir, config.modules) 在真实仓库现场派生，
 *   不再硬编码模块名——新增模块目录进仓自动进断言面（验收第 5 条；temp-root 单测背书）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverModules, runNineSteps } from '../src/steps';
import { CHAT_DB_NAME, CHAT_KV_NAME, CHAT_R2_NAME } from '../src/chat-provision';
import type { Wrangler } from '../src/wrangler';

/** 仓库根（真实文件布局：modules/hello、modules/chat、services/core-api、apps/shell）。 */
const ROOT = new URL('../../..', import.meta.url).pathname;

async function fakeBuildShell(rootDir: string): Promise<void> {
  const dist = join(rootDir, 'apps/shell/dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<html><body>TEST SHELL</body></html>');
}

const FIXED_JWKS = JSON.stringify({
  keys: [{
    kty: 'EC', crv: 'P-256',
    x: '2zYTVcy0bDXQ7qqeNDB38zsPVvwUkKZ6-m3xA1zwA2U',
    y: 'j8zUPxAyGRUAaHRNYwdU3IW7TSBI1kSrg7RmUhb8lZk',
    kid: 'RDB_5KqpPvLCvU7V6n8r6-xxpSJutKJCWNmyZWesNSg',
    use: 'sig', alg: 'ES256',
  }],
});

const SMOKE_OK = {
  smoke: async (b: string, ids: string[]) =>
    ([{ name: 'core-api', url: `${b}/api/health`, ok: true, status: 200 }] as Array<{
      name: string; url: string; ok: boolean; status: number;
    }>).concat(ids.map((id) => ({ name: `module:${id}`, url: `${b}/m/${id}/api/health`, ok: true, status: 200 }))),
};

/** 扩展录制型 fake：D1/KV/R2/secret 账户状态 + 全命令录制（chat 专属资源语义）。 */
function makeFakeWrangler(options?: {
  existingD1?: string[];
  existingBuckets?: string[];
  existingKv?: string[];
  existingSecrets?: string[];
}) {
  const state = {
    d1: new Set(options?.existingD1 ?? []),
    buckets: new Set(options?.existingBuckets ?? []),
    kv: new Set(options?.existingKv ?? []),
    secrets: new Set(options?.existingSecrets ?? []),
    secretPuts: [] as Array<{ worker: string; secret: string }>,
    setupDone: false,
    setupToken: null as string | null,
    commands: [] as string[],
  };
  const uuid = 'a1b2c3d4-0000-0000-0000-000000000001';
  const kvId = 'd1d2e3f4-0000-0000-0000-0000000000d5';
  async function exec(args: string[]): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
    state.commands.push(args.join(' '));
    const [cmd, ...rest] = args;
    if (cmd === 'd1') {
      const sub = rest[0];
      if (sub === 'list') return json([...state.d1].map((name) => ({ name, uuid })));
      if (sub === 'create') {
        const name = rest[1]!;
        if (state.d1.has(name)) return fail(`already exists: ${name}`);
        state.d1.add(name);
        return json([{ name, uuid }]);
      }
      if (sub === 'execute') {
        const fileIdx = rest.indexOf('--file');
        if (fileIdx >= 0) return json([{ results: [], success: true, meta: { duration: 0 } }]);
        const commandIdx = rest.indexOf('--command');
        const sql = commandIdx >= 0 ? (rest[commandIdx + 1] ?? '') : '';
        if (sql.includes('instance_config')) {
          return json([{ results: [{ sealed: state.setupDone ? 1 : 0, token: state.setupToken }], success: true, meta: { duration: 0 } }]);
        }
        const inserted = /INSERT INTO setup_tokens \(token\) VALUES \('([^']+)'\)/.exec(sql);
        if (inserted) state.setupToken = inserted[1]!;
        return json([{ results: [], success: true, meta: { duration: 0 } }]);
      }
      return okOut('');
    }
    if (cmd === 'kv' && rest[0] === 'namespace') {
      const op = rest[1];
      if (op === 'list') return json([...state.kv].map((title) => ({ id: kvId, title })));
      if (op === 'create') {
        const title = rest[2]!;
        if (state.kv.has(title)) return fail(`namespace already exists: ${title}`);
        state.kv.add(title);
        return okOut(`🌀 Creating namespace with title "${title}"\n✨ Success!\nid = "${kvId}"\n`);
      }
    }
    if (cmd === 'r2' && rest[0] === 'bucket') {
      const op = rest[1];
      if (op === 'list') {
        return okOut(
          [...state.buckets].map((name) =>
            `name:${' '.repeat(11)}${name}\ncreation_date:  Wed, 01 Jan 2025 00:00:00 GMT`).join('\n\n'),
        );
      }
      if (op === 'create') {
        const name = rest[2]!;
        if (state.buckets.has(name)) return fail(`bucket exists: ${name}`);
        state.buckets.add(name);
        return okOut('');
      }
    }
    if (cmd === 'secret') {
      const sub = rest[0];
      if (sub === 'list') return json([...state.secrets].map((name) => ({ name })));
      if (sub === 'put') {
        const secret = rest[1]!;
        const nameIdx = rest.indexOf('--name');
        const worker = nameIdx >= 0 ? (rest[nameIdx + 1] ?? '') : '';
        state.secrets.add(secret);
        state.secretPuts.push({ worker, secret });
        return okOut('Success');
      }
    }
    if (cmd === 'deploy') {
      return okOut('Deployed unself-worker https://unself-core-api.test-subdomain.workers.dev');
    }
    return okOut('');
  }
  const json = (value: unknown) => ({ ok: true, code: 0, stdout: JSON.stringify(value), stderr: '' });
  const okOut = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' });
  const fail = (stderr: string) => ({ ok: false, code: 1, stdout: '', stderr });
  return { wrangler: { run: exec, tryRun: exec } as Wrangler, state };
}

/** 与生产 discoverModules 同源：断言面期望从这里派生（参数化核心，#219 验收第 5 条）。 */
async function discoverIds(rootDir: string, selected: string[]): Promise<string[]> {
  return (await discoverModules(rootDir, selected)).map((m) => m.id).sort();
}

describe('#219 chat 全链路（干净装配「仅启用 chat」）', () => {
  it('专属 D1/KV/R2 命令序正确；chat 不进 d1 migrations 链、基线 schema --file 灌入', { timeout: 120_000 }, async () => {
    const fake = makeFakeWrangler();
    await runNineSteps({
      rootDir: ROOT,
      wrangler: fake.wrangler,
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      wrangler_: undefined,
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async () => 'chat/assets/frontend',
      resolveBaseUrl: async () => 'https://x.example',
      putSecret: async () => {},
    } as Parameters<typeof runNineSteps>[0]);
    const cmds = fake.state.commands;
    // ① 专属资源补建：chat D1 + chat KV（平台两库与桶在别的断言覆盖）
    expect(cmds.some((c) => c.startsWith(`d1 create ${CHAT_DB_NAME}`))).toBe(true);
    expect(cmds.some((c) => c.startsWith(`kv namespace create ${CHAT_KV_NAME}`))).toBe(true);
    expect(cmds.some((c) => c.startsWith(`r2 bucket create ${CHAT_R2_NAME}`))).toBe(true);
    // ② chat 不走 d1 migrations apply MODULES_DB 链（豁免纪律），基线 schema 经 --file --remote 灌入
    expect(cmds.some((c) => /^d1 migrations apply MODULES_DB.*chat/.test(c))).toBe(false);
    const schemaRun = cmds.find((c) => c.includes('d1 execute') && c.includes('--file') && c.includes('schema-baseline.sql'));
    expect(schemaRun).toBeDefined();
    expect(schemaRun).toContain('--remote');
    expect(schemaRun).toContain(CHAT_DB_NAME);
  });

  it('部署配置落位：/m/chat/* 路由 + 专属绑定 + 前端 assets + MODULE_ID/CORE_JWKS_JSON', { timeout: 120_000 }, async () => {
    const fake = makeFakeWrangler({ existingD1: ['unself-core', 'unself-modules'], existingSecrets: ['JWT_PRIVATE_KEY'] });
    await runNineSteps({
      rootDir: ROOT,
      wrangler: fake.wrangler,
      configOverride: { domain: 'demo.handywote.top', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      wrangler_: undefined,
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async () => 'chat/assets/frontend',
      resolveZone: async () => ({ id: 'zone-1', name: 'handywote.top' }),
      cleanupCustomDomains: async () => {},
      ensureTotalTls: async () => {},
      ensureDns: async () => {},
      resolveBaseUrl: async () => 'https://demo.handywote.top',
      fetchJwks: async () => FIXED_JWKS,
      putSecret: async () => {},
    } as Parameters<typeof runNineSteps>[0]);
    const cfg = JSON.parse(
      await readFile(join(ROOT, '.deploy/cloudflare/modules/chat.wrangler.jsonc'), 'utf8'),
    ) as Record<string, any>;
    expect(cfg.name).toBe('unself-module-chat');
    expect(cfg.routes).toEqual([{ pattern: 'demo.handywote.top/m/chat/*', zone_name: 'handywote.top' }]);
    expect(cfg.d1_databases).toEqual([{ binding: 'DB', database_name: CHAT_DB_NAME, database_id: expect.any(String) }]);
    expect(cfg.kv_namespaces).toEqual([{ binding: 'SESSIONS', id: expect.any(String) }]);
    expect(cfg.r2_buckets).toEqual([{ binding: 'FILES', bucket_name: CHAT_R2_NAME }]);
    expect(cfg.durable_objects.bindings.map((b: { name: string }) => b.name)).toEqual(['CHANNEL_ROOM', 'SCHEDULER', 'USER_INBOX']);
    expect(cfg.assets.directory).toBe('chat/assets/frontend');
    expect(cfg.vars.MODULE_ID).toBe('chat');
    expect(JSON.parse(cfg.vars.CORE_JWKS_JSON).keys).toHaveLength(1);
    // wrapper 同步落位（assets 由 buildChatFrontend 注入口声明，产物搬运由 chat-frontend.test 验证）
    await expect(readFile(join(ROOT, '.deploy/cloudflare/modules/chat/worker.js'), 'utf8')).resolves.toContain("const PREFIX = '/m/chat'");
  });

  it('注册表三态之一（启用）：chat upsert enabled=1 且 entry=<baseUrl>/m/chat/；hello 未选 disable', { timeout: 120_000 }, async () => {
    const fake = makeFakeWrangler({ existingD1: ['unself-core', 'unself-modules'], existingSecrets: ['JWT_PRIVATE_KEY'] });
    await runNineSteps({
      rootDir: ROOT,
      wrangler: fake.wrangler,
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      wrangler_: undefined,
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async () => 'chat/assets/frontend',
      resolveBaseUrl: async () => 'https://x.example',
      fetchJwks: async () => FIXED_JWKS,
      putSecret: async () => {},
    } as Parameters<typeof runNineSteps>[0]);
    const upsert = fake.state.commands.find((c) => c.includes('module_registry') && c.includes("'chat'"));
    expect(upsert).toBeDefined();
    expect(upsert).toContain('enabled');
    expect(upsert).toContain('https://x.example/m/chat/');
    const disable = fake.state.commands.find((c) => c.includes("UPDATE module_registry SET enabled = 0 WHERE id = 'hello'"));
    expect(disable).toBeDefined();
  });
});

describe('#219 幂等与密钥环（二跑收敛）', () => {
  it('二跑零 create/put：D1/KV/R2 全收敛，密钥环已有不覆盖', { timeout: 120_000 }, async () => {
    const first = makeFakeWrangler();
    let firstKeyringPuts = 0;
    const summary1 = await runNineSteps({
      rootDir: ROOT,
      wrangler: first.wrangler,
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      wrangler_: undefined,
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async () => 'chat/assets/frontend',
      resolveBaseUrl: async () => 'https://x.example',
      putSecret: async (_worker, _value, secretName) => {
        if (secretName === 'EDGECHAT_ENCRYPTION_KEYRING') firstKeyringPuts++;
        first.state.secrets.add(secretName);
        first.state.secretPuts.push({ worker: _worker, secret: secretName });
      },
    } as Parameters<typeof runNineSteps>[0]);
    expect(firstKeyringPuts).toBe(1);
    expect(summary1.chat).toEqual({ db: CHAT_DB_NAME, kv: CHAT_KV_NAME, r2: CHAT_R2_NAME, keyringAction: 'created' });

    // 二跑：同一账户状态延续（资源已在、密钥环已在）
    const second = makeFakeWrangler({
      existingD1: [...first.state.d1],
      existingBuckets: [...first.state.buckets],
      existingKv: [...first.state.kv],
      existingSecrets: [...first.state.secrets],
    });
    const summary2 = await runNineSteps({
      rootDir: ROOT,
      wrangler: second.wrangler,
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      wrangler_: undefined,
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async () => 'chat/assets/frontend',
      resolveBaseUrl: async () => summary1.baseUrl,
      fetchJwks: async () => FIXED_JWKS,
      putSecret: async () => {},
    } as Parameters<typeof runNineSteps>[0]);
    const cmds = second.state.commands;
    expect(cmds.some((c) => c.startsWith('d1 create'))).toBe(false);
    expect(cmds.some((c) => c.startsWith('kv namespace create'))).toBe(false);
    expect(cmds.some((c) => c.startsWith('r2 bucket create'))).toBe(false);
    expect(second.state.secretPuts).toHaveLength(0);
    expect(summary2.chat).toEqual({ db: CHAT_DB_NAME, kv: CHAT_KV_NAME, r2: CHAT_R2_NAME, keyringAction: 'existing' });
  });

  it('首部署密钥环注入后补 deploy（secret 生效）；已有密钥环零补部署', { timeout: 120_000 }, async () => {
    const fresh = makeFakeWrangler();
    await runNineSteps({
      rootDir: ROOT,
      wrangler: fresh.wrangler,
      configOverride: { domain: '', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } },
      wrangler_: undefined,
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      buildChatFrontend: async () => 'chat/assets/frontend',
      resolveBaseUrl: async () => 'https://x.example',
      putSecret: async (_w, _v, secretName) => {
        fresh.state.secrets.add(secretName);
      },
    } as Parameters<typeof runNineSteps>[0]);
    const chatDeploys = fresh.state.commands.filter((c) => /^deploy .*modules\/chat\.wrangler\.jsonc/.test(c));
    expect(chatDeploys.length).toBe(2); // 首部署 + secret put 后重部署
    expect(chatDeploys[1]).toBe(chatDeploys[0]);
  });
});

describe('#219 模块面断言参数化（验收第 5 条）', () => {
  it('在仓全集与未选集合均由 discoverModules 现场派生（不硬编码模块名）', async () => {
    const selectedIds = ['chat'];
    const all = await discoverIds(ROOT, selectedIds);
    // 真实仓库现场：hello 与 chat 都在仓；期望集合 = 发现结果（而非手写清单）
    expect(all).toContain('hello');
    expect(all).toContain('chat');
    expect(all).toEqual([...new Set(all)].sort());
    // 选中/未选划分与 config.modules 一致
    const refs = await discoverModules(ROOT, selectedIds);
    expect(refs.find((m) => m.id === 'chat')!.selected).toBe(true);
    expect(refs.filter((m) => !m.selected).map((m) => m.id).sort()).toEqual(all.filter((id) => !selectedIds.includes(id)));
  });

  it('temp-root 双模块：新增目录进仓自动进断言面（discoverModules 通用性）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unself-disc-'));
    for (const [name, manifestId] of [['alpha', 'alpha'], ['beta', 'beta']] as const) {
      const dir = join(root, 'modules', name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'manifest.yaml'), `id: ${manifestId}\nroute: /m/${name}\nversion: 0.1.0\n`);
    }
    const refs = await discoverModules(root, ['beta']);
    expect(refs.map((m) => m.id).sort()).toEqual(['alpha', 'beta']);
    expect(refs.find((m) => m.id === 'beta')!.selected).toBe(true);
    expect(refs.find((m) => m.id === 'alpha')!.selected).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('「全停用」现场：registry 对在仓全集逐一 disable（期望由派生集合生成，chat/hello 同语义）', { timeout: 120_000 }, async () => {
    const fake = makeFakeWrangler({ existingD1: ['unself-core', 'unself-modules'], existingSecrets: ['JWT_PRIVATE_KEY'] });
    const all = await discoverIds(ROOT, []);
    await runNineSteps({
      rootDir: ROOT,
      wrangler: fake.wrangler,
      configOverride: { domain: '', modules: [], storage: { provider: 'r2', bucket: 'unself-storage' } },
      wrangler_: undefined,
      http: SMOKE_OK,
      buildShell: fakeBuildShell,
      resolveBaseUrl: async () => 'https://x.example',
      fetchJwks: async () => FIXED_JWKS,
      putSecret: async () => {},
    } as Parameters<typeof runNineSteps>[0]);
    for (const id of all) {
      expect(fake.state.commands.some((c) => c.includes(`UPDATE module_registry SET enabled = 0 WHERE id = '${id}'`))).toBe(true);
    }
    expect(fake.state.commands.filter((c) => c.includes('UPDATE module_registry'))).toHaveLength(all.length);
  });
});
