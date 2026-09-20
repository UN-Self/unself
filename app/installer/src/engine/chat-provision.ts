// SPDX-License-Identifier: AGPL-3.0-only
/**
 * chat 专属资源供给与部署配置（#219，决策 #50；#248 存储面去豁免）：
 * chat 落点 = **dedicated 普通实例**（storage.declaration=dedicated，决策 #55/#74）：
 * 数据落自己的库 `unself-chat`，迁移走标准链（migrations/chat/ + 独立记账 unself_migrations_chat），
 * 与任何 dedicated 模块同一套装配路径——存储面不再有 chat 专属分支。
 * 本文件保留的 chat 专属面只有**模块资源**（与存储落点无关）：
 * - D1 `unself-chat`：迁移链（app/modules/chat/migrations/chat/0001_baseline.sql，逐文件记账应用；
 *   上游 23 个 migration 不搬，无「已应用迁移文件」记账问题）；
 * - KV/R2/DO/Secret：会话、附件、实时 —— 由 chat 包配置声明，装配器按声明供给。
 * - D1 `unself-chat`：迁移链（app/modules/chat/migrations/chat/0001_baseline.sql，逐文件记账应用；
 *   上游 23 个 migration 不搬，无「已应用迁移文件」记账问题）；
 * - KV `unself-chat-sessions`：会话/实时票券（worker 绑定名 SESSIONS）；
 * - R2 `unself-chat-files`：附件（worker 绑定名 FILES；可选增强，缺绑定时代码判空降级）；
 * - Secret `EDGECHAT_ENCRYPTION_KEYRING`：AES-256-GCM 消息加密密钥环，缺失时本地生成注入
 *   （已有绝不覆盖——与 core JWT_PRIVATE_KEY 同款幂等纪律）。
 * #244：供给全部走 CF REST（#65），部署配置仅作生成物核对（不再是 wrangler 的输入）。
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureD1, ensureKvNamespace, ensureR2Bucket } from './rest';
import type { RestClient } from './rest';
import { stripJsonc } from './config';
import type { UnselfConfig } from './config';
import { moduleWorkerName, resourceName } from './naming';

/** chat 专属资源名（chat- 前缀，决策 #50；可带 UNSELF_RESOURCE_PREFIX 做同账户隔离，#257）。 */
export const CHAT_MODULE_ID = 'chat';
/** chat 专属 D1 名。 */
export function chatDbName(): string {
  return resourceName('chat');
}
/**
 * SESSIONS KV namespace（#231 状态：**无写入方**）。
 * #217 把本地会话读取面换成 core 模块 JWT + JIT 后，`worker/src/session.js` 已下架；
 * #231 又停掉 `PATCH /api/me/profile` 的 putSession 回写，worker 侧再无 `env.SESSIONS` 写入。
 * 唯一残留读取是 `maintenance/system-check.ts` 的探针（`registerMaintenanceRoutes` 未挂载，路由不可达）。
 * 绑定仍保留是**过渡决定**：彻底移除需同时改 `app/modules/chat/wrangler.jsonc`
 * （`readChatPackageConfig` 的形状校验与 dev 绑定）+ `steps.ts` 的摘要面，两者不在 #231
 * 所有权内；待 M3 随本地会话残件一并清退（含删本命名空间）。
 */
export function chatKvName(): string {
  return resourceName('chat-sessions');
}
export function chatR2Name(): string {
  return resourceName('chat-files');
}
/** chat worker 的加密密钥环 secret 名（上游 Bindings 契约，EDGECHAT_ 前缀）。 */
export const CHAT_KEYRING_SECRET = 'EDGECHAT_ENCRYPTION_KEYRING';

/** worker 侧 KV 绑定名（app/modules/chat/wrangler.jsonc）。
 * #231：worker 已无 SESSIONS 消费方（见 CHAT_KV_NAME 注释），生成配置暂时代持至 M3 清退。 */
const KV_BINDING = 'SESSIONS';
/** worker 侧 R2 绑定名（可选增强；装配端始终供给，缺绑定降级逻辑不再触发）。 */
const R2_BINDING = 'FILES';

/**
 * 确保 chat 专属 D1/KV 存在，返回 id（REST 查漏补建，幂等）。
 */
export async function ensureChatResources(
  client: RestClient,
  accountId: string,
  log: (msg: string) => void,
): Promise<{ dbId: string; kvId: string }> {
  const dbId = await ensureD1(client, accountId, chatDbName(), log);
  const kvId = await ensureKvNamespace(client, accountId, chatKvName(), log);
  return { dbId, kvId };
}

/** chat 专属 R2 桶查漏（与平台桶同款纪律：只建不绑消费）。 */
export async function ensureChatR2Bucket(
  client: RestClient,
  accountId: string,
  log: (msg: string) => void,
): Promise<'exists' | 'created'> {
  return ensureR2Bucket(client, accountId, chatR2Name(), log);
}

/**
 * 生成新 chat 加密密钥环（AES-256-GCM，32B 随机 → base64（标准带 padding））：
 * `{ activeKeyId:'v1', keys:{ v1:<base64> } }`——与 worker encryption.js 的 keyring 解析
 * 及 app/modules/chat/test/chat-test-factory.ts 的 TEST_KEYRING 同形状。
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
    throw new Error('app/modules/chat/wrangler.jsonc 形状不符：需恰好一个 d1_databases 绑定');
  }
  const kvList = (parsed.kv_namespaces ?? []) as Array<Record<string, unknown>>;
  if (kvList.length !== 1 || kvList[0]!.binding !== KV_BINDING) {
    throw new Error(`app/modules/chat/wrangler.jsonc 形状不符：需恰好一个 kv_namespaces 绑定 ${KV_BINDING}`);
  }
  // #248：chat 的 schema 走标准迁移链（migrations/chat/0001_baseline.sql + 独立记账），
  // 不再有一次性灌 schema 的豁免——包内必须带标准 migrations/<id>/ 目录（落点 dedicated）。
  const migrationsDir = join(moduleDir, 'migrations', CHAT_MODULE_ID);
  if (!existsSync(migrationsDir) || readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).length === 0) {
    throw new Error('app/modules/chat/migrations/chat/ 缺失或无 .sql：chat 迁移链无法应用（本 issue）');
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
 * 生成 chat 部署描述（`.deploy/cloudflare/modules/chat.wrangler.jsonc`，调用方无条件重写）：
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
      name: moduleWorkerName(CHAT_MODULE_ID),
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
          database_name: chatDbName(),
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
          bucket_name: chatR2Name(),
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
