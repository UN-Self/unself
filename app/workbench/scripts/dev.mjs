#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `pnpm dev` 一条命令起全形态（本地 dev 一等公民，与 installer/docker 同一套迁移逻辑）：
 *
 *   ① dist/web 缺失 → `vite build`（assets 目录必须有货，wrangler dev 才能起）；
 *   ② 自动迁移：与 `wrangler d1 migrations apply --local` 同语义——按 `d1_migrations`
 *      记账（wrangler 历史库同表名同形状），已记账文件跳过；生产侧 installer 用 REST
 *      import 灌同一批 SQL（迁移文件与顺序同源 migrations/core/），docker 侧同一套
 *      逐文件记账纪律——本地不比部署多一套方言。
 *      实现走 node:sqlite 直改本地状态库（零新依赖）：
 *      - 本地状态文件名是 workerd 内部 DO idFromName 哈希，JS 侧不可复现——
 *        先 `wrangler d1 execute --local`（SELECT 1 探测命令）让 wrangler 自己踩出
 *        状态文件，再在 `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/` 下探测：
 *        非 metadata.sqlite 且带 `d1_migrations` 表的即 CORE_DB（MODULES_DB 无迁移不建账）；
 *      - 逐文件应用：执行成功才记账，失败停住不重试不回滚（#61 同规）；
 *        语句计数用朴素分号切分（仅用于失败定位「第几条」，不改执行路径）。
 *   ③ `.dev.vars` 缺失 → generateInstanceKeyPair 生成 ES256 PEM 写入 JWT_PRIVATE_KEY
 *      ——dotenv 单引号内 `\n` 读作真实换行（dotenv@17 实测），多行裸 PEM 读不到；
 *   ④ spawn `npx wrangler dev --config wrangler.dev.jsonc`（状态目录默认包根 .wrangler/）。
 *
 * 用法：`pnpm dev`（= node scripts/dev.mjs，需先 pnpm install；前端快速回路另见 `pnpm dev:web`）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PKG_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEV_CONFIG = join(PKG_DIR, 'wrangler.dev.jsonc');
const DIST_WEB = join(PKG_DIR, 'dist', 'web');
const MIGRATIONS_DIR = join(PKG_DIR, 'migrations', 'core');
const D1_STATE_DIR = join(PKG_DIR, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const DEV_VARS_PATH = join(PKG_DIR, '.dev.vars');

const log = (msg) => console.log(`[dev] ${msg}`);

/** run(npx ...)：包内 bin（wrangler/vite），wrangler 平台脚本要 shell（win32 兼容）。 */
function run(args, opts = {}) {
  return spawnSync('npx', args, {
    cwd: PKG_DIR,
    stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: process.platform === 'win32',
    ...opts.spawn,
  });
}

// ---------------------------------------------------------------------------
// ① 前端产物（assets 目录）：缺失才 build（重跑 dev 不重复等整场 vite build）
// ---------------------------------------------------------------------------
function ensureWebDist() {
  if (existsSync(join(DIST_WEB, 'index.html'))) {
    log('dist/web 已存在，跳过 vite build（改了前端要重构建：pnpm build:web）');
    return;
  }
  log('dist/web 缺失，先跑 vite build（首次 dev 约十几秒）……');
  const r = run(['vite', 'build']);
  if (r.status !== 0) {
    throw new Error(`vite build 失败（exit ${r.status}）——前端产物缺失，wrangler dev 起不来`);
  }
}

// ---------------------------------------------------------------------------
// ② 迁移：wrangler d1 migrations apply --local 同语义（d1_migrations 记账）
// ---------------------------------------------------------------------------

/**
 * 状态目录里定位 CORE_DB 本地库（返回绝对路径；定位不了抛人话错）。
 * 三分：
 * - 恰一个带 d1_migrations 表 → 就是它（正常重跑：dev 流程只有 core 建账）；
 * - 全场无带账库且非 metadata sqlite 恰一个 → 全新状态，它就是 CORE_DB
 *   （dev 流程里唯一的非 metadata 库只能由 CORE_DB 的探测/迁移/服务请求踩出；
 *   MODULES_DB 无迁移不建账，不会被本脚本先行触碰）；
 * - 其余（0 个库 / 多库无账 / 多库带账）→ 拒绝猜，报人话让清状态重来。
 */
function findCoreStateDb(dir) {
  const candidates = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  const withLedger = candidates.filter((file) => hasD1MigrationsTable(join(dir, file)));
  if (withLedger.length === 1) return join(dir, withLedger[0]);
  if (withLedger.length === 0) {
    if (candidates.length === 1) return join(dir, candidates[0]);
    throw new Error(
      candidates.length === 0
        ? `状态目录里没有可用的库文件（${dir}）——wrangler 未踩出状态，先跑一次探测`
        : `状态目录里有 ${candidates.length} 个库但都无 d1_migrations 账，无法辨认 CORE_DB——` +
            '历史状态混了别的库，删 .wrangler/state 重来（本地状态可弃）',
    );
  }
  throw new Error(
    `带 d1_migrations 账的库有 ${withLedger.length} 个（应只有 CORE_DB 一个）——历史状态混了别的库，删 .wrangler/state 重来`,
  );
}

function hasD1MigrationsTable(dbPath) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'").get();
    db.close();
    return row !== undefined;
  } catch {
    return false; // 半写/锁着的文件不当 CORE_DB（宁重踩再找，不迁进错库）
  }
}

/** wrangler 没踩出带账的库（全新机器/被清了状态）→ execute --local 探测命令踩一次再找。 */
function ensureCoreStateDb() {
  const probe = () => {
    if (!existsSync(D1_STATE_DIR)) return null;
    try {
      return findCoreStateDb(D1_STATE_DIR);
    } catch {
      return null; // 0 个或多个带账库：不猜，先踩一次再找（仍多库则下方原样上抛）
    }
  };
  const found = probe();
  if (found) return found;
  log('本地 D1 状态库未初始化，wrangler d1 execute --local 踩一次（建状态文件）……');
  const r = run(
    ['wrangler', 'd1', 'execute', 'CORE_DB', '--local', '--config', 'wrangler.dev.jsonc', '--command', 'SELECT 1', '--json'],
    { capture: true },
  );
  if (r.status !== 0) {
    throw new Error('wrangler d1 execute --local 失败——本地状态库踩不出来，迁移无从落笔');
  }
  // 直接调（不再 probe 包 catch）：0 个/多个带账库的人话错误原样上抛
  return findCoreStateDb(D1_STATE_DIR);
}

/**
 * 按记账逐文件应用 migrations/core（wrangler apply 同语义）。
 * 纯函数核心（dbPath 注入）——vitest 行为测试直接打这里（幂等/记账跳过）。
 */
// 测试可注入（vitest 直接打迁移语义；main 入口见文件尾的直执行守卫）
export { applyCoreMigrations };

function applyCoreMigrations(dbPath, migrationsDir, read = readFileSync) {
  const db = new DatabaseSync(dbPath);
  try {
    // 与 wrangler getCreateMigrationsTableQuery 同形状（wrangler 时代的库直接认账）
    db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`);
    const applied = new Set(
      db.prepare('SELECT name FROM d1_migrations ORDER BY name').all().map((r) => String(r.name)),
    );
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    const skipped = [];
    const appliedNow = [];
    for (const file of files) {
      if (applied.has(file)) {
        skipped.push(file);
        continue;
      }
      const sql = read(join(migrationsDir, file), 'utf8');
      try {
        // 整文件一次 exec（与 wrangler batch 同语义：文件内语句一条失败即停，前面已跑的语句不回滚——
        // 迁移文件全部 IF NOT EXISTS / OR IGNORE 幂等纪律，重跑安全）；成功才记账。
        db.exec(sql);
        db.prepare("INSERT INTO d1_migrations (name) VALUES (?1)").run(file);
        appliedNow.push(file);
      } catch (cause) {
        const statements = splitSqlStatements(sql);
        const raw = cause instanceof Error ? cause.message : String(cause);
        // 失败定位与装配器同款（#61）：报「文件 + 第几条语句」
        let index = statements.findIndex((s) => s.length > 0 && raw.includes(s.slice(0, 20)));
        const where = index >= 0 ? `第 ${index + 1} 条语句` : `第 ? 条语句（共 ${statements.length} 条）`;
        throw new Error(
          `迁移失败（停住，不自动重试/不回滚）：core / 文件 ${file} / ${where}\n  原因：${raw}`,
          { cause },
        );
      }
    }
    return { applied: appliedNow, skipped };
  } finally {
    db.close();
  }
}

/** dev.mjs 不走 TS 编译；keys.ts（ESM、显式扩展名）能被 Node 原生解析——动态 import 即可。 */
function loadKeysModule() {
  return import(pathToFileURL(join(PKG_DIR, 'src', 'keys.ts')).href);
}

/** 朴素语句切分（仅用于失败报错「第几条」定位，不在执行路径上；现状迁移无引号内分号）。 */
function splitSqlStatements(sql) {
  return sql
    .split(';')
    .map((s) => s.replace(/^\s*--[^\n]*\n?/gm, '').trim())
    .filter((s) => s.length > 0);
}

async function migrate() {
  const dbPath = ensureCoreStateDb();
  const report = applyCoreMigrations(dbPath, MIGRATIONS_DIR);
  if (report.applied.length > 0) {
    log(`迁移已应用 ${report.applied.length} 个：${report.applied.join('、')}`);
  }
  log(report.skipped.length > 0 ? `记账跳过 ${report.skipped.length} 个（幂等重跑）` : '迁移全部应用，无跳过');
  return dbPath;
}

// ----------------------------------------------------------------
// ②′ setup 深链接：与 docker/entrypoint.sh ③③ 同一套探测/签发语义
//    （docker 首启打印一次性 setup 链接，dev 同款——三路同逻辑，不是 docker 特有）。
//    SQL 与 core/control-plane SETUP_STATUS_SQL 同形状（SQL 单点防漂移；同款复制）。
// ----------------------------------------------------------------
const SETUP_PROBE_SQL =
  "SELECT (SELECT COUNT(*) FROM instance_config WHERE key = 'setup_done' AND value = '1') AS sealed, " +
  '(SELECT token FROM setup_tokens WHERE used_at IS NULL ORDER BY created_at LIMIT 1) AS token';

function ensureSetupLink(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(SETUP_PROBE_SQL).get();
    if (Number(row.sealed) > 0) {
      log('实例已封箱（setup 已完成），无需 setup 链接');
      return null;
    }
    let token = row.token ? String(row.token) : null;
    if (token) {
      log('复用未消费的 setup token（幂等重跑收敛）');
    } else {
      // 与 entrypoint lower(hex(randomblob(24))) 同形：48 hex，消费后自动作废
      token = randomBytes(24).toString('hex');
      db.prepare('INSERT INTO setup_tokens (token) VALUES (?1)').run(token);
      log('已签发一次性 setup token（消费后自动作废）');
    }
    // 链接不在此时打印：wrangler 实际端口要等它自己报 Ready 才知道（时序修复，#349 验收反馈）
    return token;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// ③ .dev.vars：JWT_PRIVATE_KEY 缺失时自生成（dotenv 单引号 + \n 转义，实测可读回）
// ---------------------------------------------------------------------------
async function ensureDevVars() {
  if (existsSync(DEV_VARS_PATH)) {
    log('.dev.vars 已存在，沿用（想换密钥删掉它重跑）');
    return;
  }
  const { generateInstanceKeyPair } = await loadKeysModule();
  const { privateKeyPem } = await generateInstanceKeyPair();
  // wrangler@4.129 内嵌 dotenv@16.3.1：仅双引号内做 \n→换行转义（cli.js parse 原文实测），
  // 单引号原样保留——PEM 多行读不到；单行 base64 双引号 + \n 转义往返一致（取证见 parse16 复刻）
  const singleLine = privateKeyPem.trim().replaceAll('\n', '\\n');
  const content = `# pnpm dev 自动生成（实例签名私钥，ES256）——已 gitignore，勿入库勿外传\nJWT_PRIVATE_KEY="${singleLine}"\n`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(DEV_VARS_PATH, content, { mode: 0o600 });
  log('.dev.vars 已生成（新实例密钥；JWKS 端点 /.well-known/jwks.json 可验）');
}

// ---------------------------------------------------------------------------
// ④ wrangler dev（前台进程，Ctrl-C 退出）
// ---------------------------------------------------------------------------
function startWrangler(setupToken) {
  log('起 wrangler dev（--config wrangler.dev.jsonc）……');
  const child = spawn('npx', ['wrangler', 'dev', '--config', 'wrangler.dev.jsonc'], {
    cwd: PKG_DIR,
    stdio: ['inherit', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });
  // stdout 原样转发，同时守真实端口：wrangler 报「Ready on http://localhost:<PORT>」之后，
  // 才用该端口拼 setup 深链（8788 是写死的教训——wrangler 端口会被占用时自动漂移）
  let ready = setupToken == null; // 无 token（已封箱）则无事可守
  let buf = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (ready) return;
    buf += text;
    const m = buf.match(/Ready on http:\/\/localhost:(\d+)/);
    if (m) {
      ready = true;
      console.log(
        '\n' +
          '==========================================================================\n' +
          '  ✅ Unself 核心已就绪\n' +
          '  一次性 setup 链接（点开配置管理员与实例设置；token 用后即焚，泄露请删 .wrangler 重来）：\n\n' +
          `      http://localhost:${m[1]}/setup?token=${setupToken}\n` +
          '\n' +
          '==========================================================================\n',
      );
    } else if (buf.length > 4096) {
      buf = buf.slice(-1024); // 防跨 chunk 截断：留尾窗口
    }
  });
  child.on('exit', (code) => process.exitCode = code ?? 0);
  // 转发退出信号，wrangler 干净收场
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig));
  }
}

// ---------------------------------------------------------------------------
async function main() {
  ensureWebDist();
  const dbPath = await migrate();
  await ensureDevVars();
  const setupToken = ensureSetupLink(dbPath);
  startWrangler(setupToken);
}

// 直执行守卫：import（vitest）不跑 main，只有 `node scripts/dev.mjs` 才起 dev
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[dev] 失败：${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

