// SPDX-License-Identifier: AGPL-3.0-only
/**
 * chat 专属资源供给与部署配置（#219，决策 #50 存储收口豁免）：
 * chat 不经 modules 库/SDK 收口，由装配器直接供给专属资源（chat- 前缀）：
 * - D1 `unself-chat`：基线 schema（modules/chat/worker/schema-baseline.sql，首建一次性灌入；
 *   上游 23 个 migration 不搬，无「已应用迁移文件」记账问题）；
 * - KV `unself-chat-sessions`：会话/实时票券（worker 绑定名 SESSIONS）；
 * - R2 `unself-chat-files`：附件（worker 绑定名 FILES；可选增强，缺绑定时代码判空降级）；
 * - Secret `EDGECHAT_ENCRYPTION_KEYRING`：AES-256-GCM 消息加密密钥环，缺失时本地生成注入
 *   （已有绝不覆盖——与 core JWT_PRIVATE_KEY 同款幂等纪律）；
 * - 部署配置 `.deploy/cloudflare/modules/chat.wrangler.jsonc`：无条件重写（#162/#194 纪律）。
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureR2Bucket } from './provision';
import { stripJsonc } from './config';
import type { UnselfConfig } from './config';
import type { Wrangler } from './wrangler';

/** chat 专属资源名（chat- 前缀，决策 #50）。 */
export const CHAT_MODULE_ID = 'chat';
export const CHAT_DB_NAME = 'unself-chat';
/**
 * SESSIONS KV namespace（#231 状态：**无写入方**）。
 * #217 把本地会话读取面换成 core 模块 JWT + JIT 后，`worker/src/session.js` 已下架；
 * #231 又停掉 `PATCH /api/me/profile` 的 putSession 回写，worker 侧再无 `env.SESSIONS` 写入。
 * 唯一残留读取是 `maintenance/system-check.ts` 的探针（`registerMaintenanceRoutes` 未挂载，路由不可达）。
 * 绑定仍保留是**过渡决定**：彻底移除需同时改 `modules/chat/wrangler.jsonc`
 * （`readChatPackageConfig` 的形状校验与 dev 绑定）+ `steps.ts` 的摘要面，两者不在 #231
 * 所有权内；待 M3 随本地会话残件一并清退（含删本命名空间）。
 */
export const CHAT_KV_NAME = 'unself-chat-sessions';
export const CHAT_R2_NAME = 'unself-chat-files';
/** chat worker 的加密密钥环 secret 名（上游 Bindings 契约，EDGECHAT_ 前缀）。 */
export const CHAT_KEYRING_SECRET = 'EDGECHAT_ENCRYPTION_KEYRING';

/** worker 侧 KV 绑定名（modules/chat/wrangler.jsonc）。
 * #231：worker 已无 SESSIONS 消费方（见 CHAT_KV_NAME 注释），生成配置暂时代持至 M3 清退。 */
const KV_BINDING = 'SESSIONS';
/** worker 侧 R2 绑定名（可选增强；装配端始终供给，缺绑定降级逻辑不再触发）。 */
const R2_BINDING = 'FILES';

/** chat D1 描述（parseD1List 同形状）。 */
export interface NamedId {
  name: string;
  uuid: string;
}

/** 解析 `wrangler kv namespace list` 输出：JSON 数组 [{id, title}]；容忍日志前缀与空。 */
export function parseKvNamespaceList(stdout: string): NamedId[] {
  const start = stdout.lastIndexOf('[');
  if (start < 0) return [];
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => row as Record<string, unknown>)
      .filter((row) => typeof row.title === 'string' && typeof row.id === 'string')
      .map((row) => ({ name: row.title as string, uuid: row.id as string }));
  } catch {
    return [];
  }
}

/** 解析 `wrangler kv namespace create` 输出抓 namespace id（36 位 uuid）。 */
export function parseKvCreateId(stdout: string): string | null {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(stdout)?.[1] ?? null;
}

/**
 * 确保 chat 专属 D1/KV 存在，返回 id。已存在（list 命中）→ 不创建（幂等）；
 * create 撞车（并发/瞬时 list 失败）→ 回查列表自愈。
 */
export async function ensureChatResources(
  wrangler: Wrangler,
  log: (msg: string) => void,
): Promise<{ dbId: string; kvId: string }> {
  // ---- D1 ----
  const d1Res = await wrangler.tryRun(['d1', 'list', '--json']);
  const { parseD1List } = await import('./provision');
  const dbs = d1Res.ok ? parseD1List(d1Res.stdout) : [];
  let dbId = dbs.find((db) => db.name === CHAT_DB_NAME)?.uuid ?? '';
  if (dbId) {
    log(`D1 ${CHAT_DB_NAME} 已存在（${dbId}）`);
  } else {
    const created = await wrangler.run(['d1', 'create', CHAT_DB_NAME]);
    dbId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(created.stdout)?.[1]
      ?? parseD1List(created.stdout)[0]?.uuid
      ?? '';
    if (!dbId) throw new Error(`D1 ${CHAT_DB_NAME} 创建输出未含 database_id`);
    log(`D1 ${CHAT_DB_NAME} 已创建（${dbId}）`);
  }

  // ---- KV ----
  const kvRes = await wrangler.tryRun(['kv', 'namespace', 'list']);
  const kvs = kvRes.ok ? parseKvNamespaceList(kvRes.stdout) : [];
  let kvId = kvs.find((ns) => ns.name === CHAT_KV_NAME)?.uuid ?? '';
  if (kvId) {
    log(`KV ${CHAT_KV_NAME} 已存在（${kvId}）`);
  } else {
    const created = await wrangler.run(['kv', 'namespace', 'create', CHAT_KV_NAME]);
    kvId = parseKvCreateId(created.stdout) ?? '';
    if (!kvId) throw new Error(`KV ${CHAT_KV_NAME} 创建输出未含 namespace_id`);
    log(`KV ${CHAT_KV_NAME} 已创建（${kvId}）`);
  }
  return { dbId, kvId };
}

/** 首建灌基线 schema：`d1 execute --file schema-baseline.sql --remote`（幂等：全 IF NOT EXISTS + OR IGNORE 种子）。 */
export async function applyChatSchema(input: {
  wrangler: Wrangler;
  /** 模块包根（modules/chat）。 */
  moduleDir: string;
  /** 生成迁移配置路径（真实 database_id；migrations_dir 仅占位不使用）。 */
  configPath: string;
  log: (msg: string) => void;
}): Promise<void> {
  const schemaPath = join(input.moduleDir, 'worker', 'schema-baseline.sql');
  await input.wrangler.run([
    'd1', 'execute', CHAT_DB_NAME, '--remote', '--config', input.configPath,
    '-y', '--file', schemaPath, '--json',
  ], { silent: true });
  input.log(`chat 基线 schema 已应用（${CHAT_DB_NAME} ← worker/schema-baseline.sql）`);
}

/** chat 专属 R2 桶查漏（与平台桶同款纪律：只建不绑消费，缺附件桶 worker 判空降级）。 */
export function ensureChatR2Bucket(
  wrangler: Wrangler,
  log: (msg: string) => void,
): Promise<'exists' | 'created'> {
  return ensureR2Bucket(wrangler, CHAT_R2_NAME, log);
}

/**
 * 生成新 chat 加密密钥环（AES-256-GCM，32B 随机 → base64（标准带 padding））：
 * `{ activeKeyId:'v1', keys:{ v1:<base64> } }`——与 worker encryption.js 的 keyring 解析
 * 及 modules/chat/test/chat-test-factory.ts 的 TEST_KEYRING 同形状。
 * 仅缺失时调用；明文不落盘不打印（喂 secret put 管道后即弃）。
 */
export function generateChatKeyring(): string {
  const key = randomBytes(32).toString('base64');
  return JSON.stringify({ activeKeyId: 'v1', keys: { v1: key } });
}

/** chat 包 wrangler.jsonc 中与部署面相关的绑定描述（解析结果形状）。 */
interface ChatPackageConfig {
  vars: Record<string, string>;
  d1Binding: string;
  doBindings: Array<{ name: string; class_name: string }>;
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
}

/** 读包配置（零依赖 stripJsonc）：vars、D1 绑定名、DO 绑定与 migrations（部署面所需子集）。 */
export async function readChatPackageConfig(moduleDir: string): Promise<ChatPackageConfig> {
  const text = await readFile(join(moduleDir, 'wrangler.jsonc'), 'utf8');
  const parsed = JSON.parse(stripJsonc(text)) as Record<string, unknown>;
  const d1List = (parsed.d1_databases ?? []) as Array<Record<string, unknown>>;
  if (d1List.length !== 1 || typeof d1List[0]!.binding !== 'string') {
    throw new Error('modules/chat/wrangler.jsonc 形状不符：需恰好一个 d1_databases 绑定');
  }
  const kvList = (parsed.kv_namespaces ?? []) as Array<Record<string, unknown>>;
  if (kvList.length !== 1 || kvList[0]!.binding !== KV_BINDING) {
    throw new Error(`modules/chat/wrangler.jsonc 形状不符：需恰好一个 kv_namespaces 绑定 ${KV_BINDING}`);
  }
  if (!existsSync(join(moduleDir, 'worker', 'schema-baseline.sql'))) {
    throw new Error('modules/chat/worker/schema-baseline.sql 缺失：chat D1 基线 schema 无法应用');
  }
  const doRaw = (parsed.durable_objects ?? {}) as { bindings?: unknown };
  return {
    vars: (parsed.vars ?? {}) as Record<string, string>,
    d1Binding: d1List[0]!.binding as string,
    doBindings: (((doRaw.bindings ?? []) as Array<Record<string, string>>)).map((b) => ({
      name: b.name!,
      class_name: b.class_name!,
    })),
    migrations: ((parsed.migrations ?? []) as Array<Record<string, unknown>>).map((m) => ({
      tag: String(m.tag),
      new_sqlite_classes: (m.new_sqlite_classes ?? []) as string[],
    })),
  };
}

/**
 * 生成 chat 部署配置（`.deploy/cloudflare/modules/chat.wrangler.jsonc`，调用方无条件重写）：
 * 与 hello 同款骨架（wrapper main/ASSETS/zone 路由/CORE_JWKS_JSON），专属差异：
 * D1=chat 库、KV=会话命名空间、R2=附件桶、DO 三绑定 + SQLite 迁移、vars=包配置直通。
 * 同输入字节级一致（确定性 = 幂等前提）。
 */
export function chatWranglerConfig(input: {
  config: UnselfConfig;
  dbIds: { modules: string; chat: string };
  kvId: string;
  /** 部署期注入的 core 公钥 JWKS 字符串（模块本地验签）。 */
  jwksJson: string;
  zoneName?: string;
  /** 包配置解析结果（vars/绑定名/DO/migrations）。 */
  pkg: ChatPackageConfig;
  /** 前端产物目录（相对配置文件所在目录 modules/）。 */
  assetsDir: string;
}): string {
  const { config, dbIds, kvId, jwksJson, zoneName, pkg, assetsDir } = input;
  return JSON.stringify(
    {
      $schema: 'node_modules/wrangler/config-schema.json',
      name: `unself-module-${CHAT_MODULE_ID}`,
      // wrapper 独占入口（剥 /m/chat 前缀 + ASSETS 回退）；bundle 在 chat/app.js
      main: `${CHAT_MODULE_ID}/worker.js`,
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      // §5.3 单域名路径制：/m/chat/* zone 路径路由（zone_name 由部署脚本 API 探测注入）
      ...(config.domain
        ? { routes: [{ pattern: `${config.domain}/m/${CHAT_MODULE_ID}/*`, zone_name: zoneName }] }
        : {}),
      assets: {
        // chat 前端构建产物（index.html + 相对引用资产）；仅根路径回 index.html 由 wrapper 判定
        directory: assetsDir,
        binding: 'ASSETS',
        not_found_handling: 'none',
        // 全部请求先跑 Worker（模块自管资产回退），与 hello 同款
        run_worker_first: true,
      },
      d1_databases: [
        {
          binding: pkg.d1Binding,
          database_name: CHAT_DB_NAME,
          database_id: dbIds.chat,
        },
      ],
      kv_namespaces: [
        {
          binding: KV_BINDING,
          id: kvId,
        },
      ],
      r2_buckets: [
        {
          binding: R2_BINDING,
          bucket_name: CHAT_R2_NAME,
        },
      ],
      durable_objects: { bindings: pkg.doBindings },
      ...(pkg.migrations.length > 0 ? { migrations: pkg.migrations } : {}),
      vars: {
        MODULE_ID: CHAT_MODULE_ID,
        // 部署期注入公钥 JWKS（模块本地验签零运行时网络），其余 vars 包配置直通
        ...pkg.vars,
        CORE_JWKS_JSON: jwksJson,
      },
      observability: { enabled: true },
    },
    null,
    2,
  );
}
