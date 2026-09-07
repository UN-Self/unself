// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 幂等九步编排（PRODUCT_SPEC §5.5，#14）：
 * ① 两 D1 → ② 迁移 → ③ Shell Worker → ④ 模块构建/上传/路由绑定 → ⑤ registry
 * → ⑥ R2 → ⑦ OIDC（无操作，setup 向导录入）→ ⑧ setup token → ⑨ 冒烟。
 * 所有资源查漏后补建：连跑两次收敛（#14 验收）。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import {
  DEPLOY_DIR,
  coreWranglerConfig,
  moduleWranglerConfig,
  prefixStripWrapperSource,
  provisionAll,
  writeConfig,
  type Provisioned,
} from './assemble';
import { loadUnselfConfig, type ModuleRef } from './config';
import { createKeypair, detectExistingSecret, putSecret, JWT_SECRET_NAME } from './keypair';
import { ensureDatabases, ensureR2Bucket, validateS3Storage, CORE_DB_NAME, MODULES_DB_NAME } from './provision';
import { registryCommands } from './registry';
import { fetchSetupToken, parseWorkersDevFromDeployOutput, smokeCheck } from './smoke';
import type { Wrangler } from './wrangler';

/** 迁移目录（相对各包根）。 */
const CORE_MIGRATIONS_DIR = 'services/core-api/migrations/core';
/** JWKS 端点路径（core-api 契约）。 */
export const JWKS_PATH = '/.well-known/jwks.json';

export interface StepReporter {
  step(n: number, title: string): void;
  log(msg: string): void;
}

export function consoleReporter(): StepReporter {
  return {
    step: (n, title) => console.log(`\n━━━ 步骤（${n}/9）${title}`),
    log: (msg) => console.log(`  ${msg}`),
  };
}

/** 扫描 modules 目录下各 manifest.yaml → ModuleRef[]（选中态按 config.modules 标注）。 */
export async function discoverModules(rootDir: string, selectedIds: string[]): Promise<ModuleRef[]> {
  const { readdir } = await import('node:fs/promises');
  const modulesDir = join(rootDir, 'modules');
  if (!existsSync(modulesDir)) return [];
  const refs: ModuleRef[] = [];
  for (const entry of (await readdir(modulesDir, { withFileTypes: true }))) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(modulesDir, entry.name, 'manifest.yaml');
    if (!existsSync(manifestPath)) continue;
    const text = await readFile(manifestPath, 'utf8');
    const { manifestId } = await import('./config');
    const id = manifestId(text) ?? entry.name;
    refs.push({ id, dir: join(modulesDir, entry.name), selected: selectedIds.includes(id) });
  }
  // 配置里选了但仓库里不存在的模块 → 明确失败（部署半套没人受益）
  const found = new Set(refs.map((r) => r.id));
  for (const id of selectedIds) {
    if (!found.has(id)) {
      throw new Error(`unself.config.jsonc 选中模块 "${id}" 不存在（modules/ 下无该 manifest.yaml）`);
    }
  }
  return refs;
}

/** 九步主流程。返回部署摘要（供测试断言与部署输出）。 */
export async function runNineSteps(input: {
  rootDir: string;
  wrangler: Wrangler;
  reporter?: StepReporter;
  /** 测试注入口：跳过真实 HTTP（冒烟/setup token）。 */
  http?: {
    setupToken(baseUrl: string): Promise<{ token: string; setupUrl: string } | { sealed: true }>;
    smoke(baseUrl: string, moduleIds: string[]): Promise<Array<{ name: string; url: string; ok: boolean; status: number; detail?: string }>>;
  };
  /** 测试注入口：跳过 workers.dev URL 解析（fake wrangler 无真实输出）。 */
  resolveBaseUrl?: (domain: string, workerName: string) => Promise<string>;
  /** 测试注入口：拦截 secret put（默认走真实 spawn）。 */
  putSecret?: (workerName: string, value: string) => Promise<void>;
}): Promise<Summary> {
  const { rootDir, wrangler } = input;
  const rep = input.reporter ?? consoleReporter();
  const config = await loadUnselfConfig(rootDir);
  validateS3Storage(config);
  const modules = await discoverModules(rootDir, config.modules);
  const selected = modules.filter((m) => m.selected);

  // ① D1
  rep.step(1, '确保 core/modules 两个 D1 存在');
  const dbIds = await ensureDatabases(wrangler, rep.log);

  // ② 迁移（core + 各选中模块；未选模块不动数据）
  rep.step(2, '跑核心迁移与选中模块迁移（表前缀版本化）');
  await wrangler.run([
    'd1', 'migrations', 'apply', 'CORE_DB',
    '--local', 'false',
    '--config', join(rootDir, 'services/core-api/wrangler.jsonc'),
  ]);
  rep.log('core 迁移已应用（unself-core）');
  for (const mod of selected) {
    await wrangler.run([
      'd1', 'migrations', 'apply', 'MODULES_DB',
      '--local', 'false',
      '--config', join(mod.dir, 'wrangler.jsonc'),
    ]);
    rep.log(`模块 ${mod.id} 迁移已应用`);
  }

  // ③ Shell Worker（构建 + 生成配置 + 上传）
  rep.step(3, '构建上传 Shell Worker（壳 + Core API）');
  const provisionInput = {
    rootDir,
    config,
    modules,
    dbIds,
    keypair: { existing: true } as const,
    wrangler,
  };
  const provisioned: Provisioned = await provisionAll(provisionInput);

  // 签名密钥：已有 secret 绝不重生成（幂等核心）
  const hasSecret = await detectExistingSecret(wrangler, provisioned.coreName);
  let freshPair: Awaited<ReturnType<typeof createKeypair>> | null = null;
  if (!hasSecret) {
    freshPair = await createKeypair();
    rep.log('未检出 JWT_PRIVATE_KEY：本地生成新 ES256 密钥对（仅本次）');
  } else {
    rep.log('JWT_PRIVATE_KEY 已配置：沿用现有签名密钥');
  }

  // core 部署配置生成（在部署前生成，secret put 需要 Worker 先存在 → 首次先裸部署再补 secret）
  await writeConfig(
    join(provisioned.outDir, 'core.wrangler.jsonc'),
    coreWranglerConfig({ config, dbIds, coreName: provisioned.coreName }),
  );
  await writeFileIfMissing(
    join(provisioned.outDir, 'core-worker.js'),
    coreWorkerEntrySource(),
  );
  await wrangler.run(['deploy', '--config', join(provisioned.outDir, 'core.wrangler.jsonc')]);
  if (freshPair) {
    if (input.putSecret) {
      await input.putSecret(provisioned.coreName, freshPair.privateKeyPem);
      rep.log('写入 secret JWT_PRIVATE_KEY（测试注入口）');
    } else {
      await putSecretStdin({
        wranglerBin: wranglerBin(rootDir),
        rootDir,
        workerName: provisioned.coreName,
        value: freshPair.privateKeyPem,
        log: rep.log,
      });
    }
    // secret put 会触发重新部署使 secret 生效
    await wrangler.run(['deploy', '--config', join(provisioned.outDir, 'core.wrangler.jsonc')]);
  }
  const baseUrl = await resolveBaseUrl(input, config.domain ?? '', provisioned.coreName, wrangler, rep);
  provisioned.baseUrl = baseUrl;

  // ④ 模块构建/上传/路由绑定
  rep.step(4, '构建上传模块 Worker，绑 /m/<id>/* 路由与存储绑定');
  for (const mod of provisioned.modules) {
    await writeConfig(
      join(provisioned.outDir, `modules/${mod.id}.wrangler.jsonc`),
      moduleWranglerConfig({ config, dbIds: { modules: dbIds.modules }, mod, jwksPath: JWKS_PATH }),
    );
    await writeFileIfMissing(
      join(provisioned.outDir, `modules/${mod.id}/index.js`),
      prefixStripWrapperSource(mod.id),
    );
    await wrangler.run(['deploy', '--config', join(provisioned.outDir, `modules/${mod.id}.wrangler.jsonc`)]);
    rep.log(`模块 ${mod.id} 已部署（路由 /m/${mod.id}/*）`);
  }

  // ⑤ registry 写入
  rep.step(5, '注册表写入（选中 enabled，未选 not_deployed）');
  const manifestTexts: Record<string, string> = {};
  for (const mod of modules) {
    manifestTexts[mod.id] = await readFile(join(mod.dir, 'manifest.yaml'), 'utf8');
  }
  for (const cmd of registryCommands({ config, modules, baseUrl, manifestTexts })) {
    const args = ['d1', 'execute', MODULES_DB_NAME, '--command', cmd.sql];
    if (cmd.binds?.length) {
      for (const bind of cmd.binds) {
        args.push('--param', jsonParam(bind));
      }
    }
    args.push('-y', '--remote');
    await wrangler.run(args, { silent: true });
    rep.log(cmd.description);
  }

  // ⑥ R2 / S3
  rep.step(6, '建 R2 桶或接收外部 S3 参数');
  if (config.storage.provider === 'r2') {
    await ensureR2Bucket(wrangler, config.storage.bucket, rep.log);
  } else {
    rep.log(`外部 S3：endpoint=${config.storage.endpoint} bucket=${config.storage.bucket}（不建桶）`);
  }

  // ⑦ OIDC（无操作）
  rep.step(7, 'OIDC 配置（不在脚本/配置文件中——部署后在 setup 向导填写）');
  rep.log('跳过：OIDC 凭证由部署者在 setup 向导录入，存 core 库（§5.5 已知缺口见 spec）');

  // ⑧ setup token
  rep.step(8, '生成一次性 setup token');
  const setup = input.http
    ? await input.http.setupToken(baseUrl)
    : await fetchSetupToken({ baseUrl, log: rep.log });

  // ⑨ 冒烟
  rep.step(9, '冒烟检查 /api/health 与各模块 health');
  const smoke = input.http
    ? await input.http.smoke(baseUrl, selected.map((m) => m.id))
    : await smokeCheck({ baseUrl, moduleIds: selected.map((m) => m.id) });
  for (const r of smoke) {
    rep.log(`${r.ok ? '✓' : '✗'} ${r.name} → ${r.url}${r.detail ? `（${r.detail}）` : ''}`);
  }
  const failed = smoke.filter((r) => !r.ok);
  if (failed.length > 0) {
    throw new Error(`冒烟失败：${failed.map((f) => f.name).join('、')}（详情见上方）`);
  }

  return {
    baseUrl,
    core: { name: provisioned.coreName, config: provisioned.coreConfig },
    modules: provisioned.modules.map((m) => ({ id: m.id, config: m.config })),
    d1: dbIds,
    r2Bucket: provisioned.r2Bucket,
    setup: 'sealed' in setup ? { sealed: true as const } : { setupUrl: setup.setupUrl },
    keypairAction: freshPair ? 'created' : 'existing',
  };
}

/** baseUrl 决策：config.domain 优先；否则从 deploy 输出抓 workers.dev。 */
async function resolveBaseUrl(
  input: { resolveBaseUrl?: (domain: string, workerName: string) => Promise<string>; http?: unknown },
  domain: string,
  workerName: string,
  wrangler: Wrangler,
  rep: StepReporter,
): Promise<string> {
  if (input.resolveBaseUrl) {
    return input.resolveBaseUrl(domain, workerName);
  }
  if (domain) {
    return `https://${domain}`;
  }
  const res = await wrangler.tryRun(['deploy', '--dry-run']);
  void res;
  rep.log('未配置 domain：以 workers.dev 域名对外（unself.config.jsonc domain 留空）');
  const probe = await wrangler.tryRun(['triggers', 'deploy', '--dry-run']);
  void probe;
  // wrangler deploy 的 stdout 已在步骤③消耗；此处用 triggers 输出解析不到时退回触发一次触发器查询
  const triggerRes = await wrangler.tryRun(['deploy', '--dry-run', '--outdir', '/tmp/unself-dryrun']);
  const url = parseWorkersDevFromDeployOutput(triggerRes.stdout) ?? '';
  if (!url) {
    throw new Error('无法从 wrangler 输出解析 workers.dev 域名；请在 unself.config.jsonc 配置 domain');
  }
  return url;
}

/** secret put（stdin 喂值）：正式部署路径；测试以注入 fake Wrangler 时不会走到此处之外的真实 spawn——
 *  幂等收敛测试首跑带 freshPair，也需要 put。为了让 fake 账户可测，提供 spy 挂点：
 *  单测通过 env UNSELF_SKIP_SECRET_PUT=1 跳过真实 spawn（fake 状态由测试自记）。 */
function putSecretStdin(input: {
  wranglerBin: string;
  rootDir: string;
  workerName: string;
  value: string;
  log: (msg: string) => void;
}): Promise<void> {
  if (process.env.UNSELF_SKIP_SECRET_PUT === '1') {
    input.log(`[skip] 写入 secret ${JWT_SECRET_NAME} → ${input.workerName}（UNSELF_SKIP_SECRET_PUT=1）`);
    return Promise.resolve();
  }
  return putSecret(input.wranglerBin, input.rootDir, input.workerName, input.value, input.log);
}

function wranglerBin(rootDir: string): string {
  const local = join(rootDir, 'node_modules', '.bin', 'wrangler');
  return existsSync(local) ? local : 'wrangler';
}

function jsonParam(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function writeFileIfMissing(path: string, content: string): Promise<void> {
  if (!existsSync(path)) {
    await writeConfig(path, content);
  }
}

/** core Worker 入口（薄壳：re-export core-api 的 Hono app + ASSETS 兜底）。 */
export function coreWorkerEntrySource(): string {
  return `// SPDX-License-Identifier: AGPL-3.0-only
// 由 deploy/cloudflare 生成：core-api Hono app + 非 API 路径回退 SPA 资产。
import app from '../../../services/core-api/src/index.ts';

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
`;
}

export interface Summary {
  baseUrl: string;
  core: { name: string; config: string };
  modules: Array<{ id: string; config: string }>;
  d1: { core: string; modules: string };
  r2Bucket?: string;
  setup: { sealed: true } | { setupUrl: string };
  keypairAction: 'created' | 'existing';
}

export { CORE_DB_NAME, MODULES_DB_NAME, DEPLOY_DIR };
