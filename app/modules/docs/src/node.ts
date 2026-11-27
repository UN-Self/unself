// SPDX-License-Identifier: AGPL-3.0-only
/**
 * docs 模块 node 入口（#358 T1）：node:sqlite 建 executor → 启动跑迁移 → 装配 app →
 * 三行调用 @unself/sdk/host 反连 core。通用机器（HTTP 宿主、dial-home、manifest 自报）
 * 全在 sdk，此处零协议代码。
 *
 * 进程环境变量（宿主只认进程 env、不读 .env 文件；文件加载交给调用方）：
 * - `UNSELF_CORE_URL` / `UNSELF_MODULE_KEY`：齐备才拨号；缺任一 = 只跑本地 HTTP
 * - `CORE_JWKS_JSON`：core 签名公钥，部署期注入（安装器 README「Docker 等价注记」：容器化
 *   模块与 CF 形态同一变量、同一语义——本地验签，零运行时网络取钥）。缺它不影响启动，
 *   但每个带 token 的 /api/docs、/life/* 请求都会回 503 `jwks_unavailable`（不带 token 的仍是 401）；
 *   有值但不是合法的公钥集（JSON 坏、没有 keys、任一键残缺）则直接起不来——否则运行期每个请求
 *   都会被当成「令牌无效」回 401，把配置错误伪装成用户问题。
 * - `DOCS_DB_PATH`：SQLite 文件路径，默认 `data/docs.sqlite`（相对包根）
 * - `UNSELF_MODULE_ADDR`：本地监听地址（sdk/host 认领）
 *
 * 页面：包内 assets/（前端构建产物）由 static.ts 服务，挂在业务路由之前。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalJWKSet } from 'jose';

import { verifyModuleToken } from '@unself/sdk';
import { startDialHome, type StartDialHomeOptions } from '@unself/sdk/host';

import { createDocsApp } from './app';
import type { TokenVerifier } from './auth/bearer';
import { createSqliteExecutor } from './d1-sqlite';
import { createHealthApp } from './health';
import { createLifeApp } from './life';
import { loadModuleManifest } from './manifest';
import { applyDocsMigrations } from './migrations';
import { serveAssetsFrom } from './static';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * 由注入的 JWKS 建验签器；缺变量返回 null（装配层据此回 503，不冒充 401）。
 * 有值就在启动现场把它建成密钥集：JSON 坏 / 形状不对 / keys 为空 / 任一键残缺都抛错，
 * 进程起不来。否则运行期每个请求都会被当成「令牌无效」回 401，把配置错误伪装成用户问题。
 */
function createVerifier(coreJwksJson: string | undefined, audience: string): TokenVerifier | null {
  if (coreJwksJson === undefined || coreJwksJson.trim() === '') return null;
  const parsed: unknown = JSON.parse(coreJwksJson);
  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('CORE_JWKS_JSON 不是合法的 JWKS：缺少非空的 keys 数组');
  }
  keys.forEach((key: unknown, index) => assertUsableKey(key, index));
  createLocalJWKSet(parsed as Parameters<typeof createLocalJWKSet>[0]);
  return (token) => verifyModuleToken(token, { coreJwksJson, audience });
}

/**
 * 逐键检查形状。jose 建密钥集时只看 `keys` 是不是对象数组，`{"keys":[{}]}` 要到验签才失败，
 * 所以在这里把残缺的键挡在启动现场。每种密钥类型给出它必然带的坐标字段。
 */
function assertUsableKey(key: unknown, index: number): void {
  const fail = (reason: string): never => {
    throw new Error(`CORE_JWKS_JSON 不是合法的 JWKS：keys[${index}] ${reason}`);
  };
  if (typeof key !== 'object' || key === null) fail('不是对象');
  const record = key as Record<string, unknown>;
  const kty = record.kty;
  if (typeof kty !== 'string' || kty === '') return fail('缺少 kty');
  const required: Readonly<Record<string, readonly string[]>> = {
    EC: ['x', 'y'],
    OKP: ['x'],
    RSA: ['n', 'e'],
  };
  for (const field of required[kty] ?? []) {
    const value = record[field];
    if (typeof value !== 'string' || value === '') fail(`缺少 ${field}`);
  }
}

const manifest = await loadModuleManifest();
const moduleId = manifest?.id ?? 'docs';

// ---- 先做纯配置检查：公钥坏就在任何落盘之前退出，不在机器上留下迁移过的空库 ----
const verifier = createVerifier(process.env.CORE_JWKS_JSON, moduleId);
if (verifier === null) {
  console.warn('未配置 CORE_JWKS_JSON：带 token 的请求将一律回 503 jwks_unavailable');
}

// ---- 数据面：建库文件 → 迁移（独立账本 unself_migrations_docs）----
const dbPath = resolve(PACKAGE_ROOT, process.env.DOCS_DB_PATH ?? 'data/docs.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
// 一个库文件只给一个进程用；忙等待只是兜住「上一个进程还没完全退出」的瞬间，不是支持多进程共写
const sqlite = new DatabaseSync(dbPath, { timeout: 5000 });
const outcome = await applyDocsMigrations(createSqliteExecutor(sqlite));
console.log(`docs 迁移就绪：新增 ${outcome.applied.length}，已跳过 ${outcome.skipped.length}（${dbPath}）`);

// ---- 应用装配：健康检查 + 生命周期 + 业务路由，同一个 Hono ----
const app = createDocsApp({ verifier, db: createSqliteExecutor(sqlite) });
app.route('/', createHealthApp({ version: manifest?.version }));
app.route('/', createLifeApp({ verifier }));

// 页面请求（assets/ 下的静态文件 + 单页回退）先于业务路由；/api/*、/life/* 不被认领，落回 Hono
const assetsDir = join(PACKAGE_ROOT, 'assets');
if (!existsSync(join(assetsDir, 'index.html'))) {
  console.warn(
    `未找到前端页面（${assetsDir}）：接口照常，但打开页面会是 404。` +
      '先构建前端：pnpm --filter @unself/module-docs-frontend run build',
  );
}
const serveAssets = serveAssetsFrom(assetsDir);
const handler = async (request: Request): Promise<Response> =>
  (await serveAssets(request)) ?? app.fetch(request);

const handle = startDialHome({ handler, manifest } as StartDialHomeOptions);

/** 监听是异步完成的：addr() 到手后再打就绪日志（否则永远打出「监听中」）。 */
function logReady(): void {
  const addr = handle.addr();
  if (addr === null) {
    setImmediate(logReady);
    return;
  }
  console.log(`docs 模块已就绪：http://${addr}/（${moduleId} v${manifest?.version ?? '?'}，数据落 self）`);
  if (process.env.UNSELF_CORE_URL && process.env.UNSELF_MODULE_KEY) {
    console.log(`已开始反连 ${process.env.UNSELF_CORE_URL}`);
  } else {
    console.log('未配置 UNSELF_CORE_URL / UNSELF_MODULE_KEY：只跑本地 HTTP，不拨号');
  }
}
logReady();

const shutdown = () => {
  handle.stop();
  sqlite.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
