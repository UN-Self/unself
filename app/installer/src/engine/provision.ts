// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cloudflare 资源供给（①⑥，决策 #65 REST 化）：账户定位 / D1 与 R2/KV 查漏补建。
 * 一切「已存在则跳过」的判断都基于查询结果，保证重跑收敛（#14 验收）。
 */
import { ensureD1, ensureR2Bucket, ensureKvNamespace } from './rest';
import type { RestClient } from './rest';
import type { UnselfConfig } from './config';
import { modulesDbName, coreDbName } from './naming';

/** 解析 REST 客户端的目标账户 id（多账户取第一个，与旧 findAccountId 行为一致）。 */
export async function resolveAccount(client: RestClient): Promise<string> {
  const res = await client.get<Array<{ id: string; name: string }>>('/accounts');
  const id = res.result[0]?.id;
  if (!id) {
    throw new Error('CF 账户列表为空（token 有效但无可见账户）——检查凭证与账户授权');
  }
  return id;
}

export { modulesDbName, coreDbName };

/** 外部 S3 参数校验（步骤⑥的 s3 分支）：缺参数直接失败，不碰 CF。 */
export function validateS3Storage(config: UnselfConfig): void {
  if (config.storage.provider === 's3') {
    if (!config.storage.endpoint || !config.storage.bucket) {
      throw new Error('storage.provider=s3 需要提供 endpoint 与 bucket（unself.config.jsonc）');
    }
  }
}

/** 确保两个 D1 存在，返回 name → database_id 映射（步骤①）。 */
export async function ensureDatabases(
  client: RestClient,
  accountId: string,
  log: (msg: string) => void = console.log,
): Promise<{ core: string; modules: string }> {
  return {
    core: await ensureD1(client, accountId, coreDbName(), log),
    modules: await ensureD1(client, accountId, modulesDbName(), log),
  };
}

export { ensureR2Bucket, ensureKvNamespace };
export type { RestClient };
