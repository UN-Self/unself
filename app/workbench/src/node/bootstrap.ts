// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node 运行体组合根（#360）：打开数据库 → 跑 core 迁移 → 自举签名私钥 → 装配头像存储
 * → 首启 mint setup token → 组出与 Worker 入口同形的 `ProdEnv` 与 Hono app。
 *
 * 首启深链接由 `workbench start`（`src/cli.ts` → `startNode`）负责：探测未封箱则签发/复用一次性 token，
 * stdout 打印醒目链接（复用 `ControlPlane.issueSetupToken`，不另写一套状态判定）。
 */
import { createStalwartMailProvisioner, toStalwartProvisionerConfig } from '@unself/stalwart-provisioner';

import { createApp, type Bindings } from '../index';
import { localAvatarStore } from '../adapters/local-avatar-store';
import { s3AvatarStore } from '../adapters/s3-avatar-store';
import { generateOneTimeToken } from '../one-time-token';
import type { AvatarStore } from '../services/avatar-store';
import type { NodeConfig } from './config';
import { openNodeDatabase, type NodeDatabase } from './database';
import { toD1Database } from './d1-executor';
import { createAssetsFetcher, type AssetsFetcher } from './assets-fetcher';
import { resolveSigningKey } from './signing-key';
import { createTunnelRuntime, type TunnelRuntime } from './tunnel-runtime';
import type { ProdEnv, WorkbenchApp } from '../prod-handler';

export interface NodeRuntime {
  env: ProdEnv;
  app: WorkbenchApp;
  assets: AssetsFetcher;
  tunnel: TunnelRuntime;
  database: NodeDatabase;
  signingKey: { source: 'env' | 'file' | 'generated'; path: string };
  /** 未封箱时打印过的深链接（封箱/quiet 时 null）。 */
  setupLink: string | null;
  close(): Promise<void>;
}

function createAvatarStore(config: NodeConfig): AvatarStore | null {
  if (!config.files) return null;
  if (config.files.kind === 'local') return localAvatarStore(config.files.dir);
  return s3AvatarStore(config.files);
}

function printSetupLink(baseUrl: string, token: string): void {
  console.log(
    [
      '',
      '==========================================================================',
      '  ✅ Unself 核心已就绪',
      '  一次性 setup 链接（点开配置管理员与实例设置；token 用后即焚，泄露请重建数据卷）：',
      '',
      `      ${baseUrl}/setup?token=${token}`,
      '',
      `  （UNSELF_BASE_URL=${baseUrl}）`,
      '==========================================================================',
      '',
    ].join('\n'),
  );
}

/** 装配 Node 运行体（不监听端口；端口由 server.ts 负责）。 */
export async function bootstrapNode(
  config: NodeConfig,
  processEnv: NodeJS.ProcessEnv = process.env,
  options: { quiet?: boolean } = {},
): Promise<NodeRuntime> {
  const database = await openNodeDatabase(config.database, config.migrationsDir);
  const signingKey = await resolveSigningKey(processEnv, config.dataDir);
  const assets = createAssetsFetcher(config.assetsDir);
  const d1 = toD1Database(database.executor, {
    transaction: database.transaction,
    transactionSync: database.transactionSync,
  });
  const tunnel = createTunnelRuntime(d1);
  const avatarStore = createAvatarStore(config);

  // 首启：探测未封箱则签发/复用一次性 token（`workbench start` 的唯一一套，容器与裸机共用）。
  let setupLink: string | null = null;
  const issued = await database.controlPlane.issueSetupToken(generateOneTimeToken);
  if (issued.status !== 'sealed') {
    const baseUrl = config.baseUrl ?? `http://localhost:${config.port}`;
    setupLink = `${baseUrl}/setup?token=${issued.token}`;
    if (!options.quiet) {
      console.log(`[node] core 迁移：${database.migrationReport.applied.length} 个应用、${database.migrationReport.skipped.length} 个跳过`);
      console.log(`[node] 实例签名私钥：${signingKey.source}（${signingKey.path}）`);
      if (!config.files) console.log('[node] 头像存储未配置（UNSELF_FILES 未设 = 该能力关闭）');
      printSetupLink(baseUrl, issued.token);
    }
  } else if (!options.quiet) {
    console.log(`[node] core 迁移：${database.migrationReport.applied.length} 个应用、${database.migrationReport.skipped.length} 个跳过`);
    console.log(`[node] 实例签名私钥：${signingKey.source}（${signingKey.path}）`);
    console.log('[node] 实例已配置（setup 已封箱）：跳过 token 签发');
  }

  const app = createApp({
    createMailProvisioner: (cfg) => createStalwartMailProvisioner(toStalwartProvisionerConfig(cfg)),
    createAvatarStore: () => avatarStore,
  });

  // MODULES_DB 目前在 `src/` 只有类型声明、无实际读取（模块数据走 installer 侧）；
  // 为保持 Bindings 形状给同一个执行器，未来真有第二库时在这里换。
  const env: ProdEnv = {
    CORE_DB: d1,
    MODULES_DB: d1,
    PROFILE_FILES: undefined,
    ASSETS: assets as unknown as Fetcher,
    CONNECT_TUNNEL: tunnel.namespace,
    JWT_PRIVATE_KEY: signingKey.pem,
  } satisfies Bindings & ProdEnv;

  return {
    env,
    app: app as unknown as WorkbenchApp,
    assets,
    tunnel,
    database,
    signingKey: { source: signingKey.source, path: signingKey.path },
    setupLink,
    async close(): Promise<void> {
      await tunnel.close();
      await database.close();
    },
  };
}
