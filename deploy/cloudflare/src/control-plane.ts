// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cloudflare 控制面（决策 #64/#65 的 CF 侧装配器实现）：
 * 把 deploy/cloudflare/src/rest 的 D1 REST 原语绑到 @unself/control-plane 的
 * RestD1ControlPlane 上（同一份 SQL），九步编排据此写注册表 / 签发 setup token / 应用迁移。
 */
import { RestD1ControlPlane } from '@unself/control-plane';
import type { ControlPlane, RestD1Executor } from '@unself/control-plane';
import { d1Import, d1Query, type RestClient } from './rest';

/** 装配器侧执行器：绑定 accountId + databaseId 后跑共用 SQL。 */
class RestExecutor implements RestD1Executor {
  constructor(
    private readonly client: RestClient,
    private readonly accountId: string,
    private readonly databaseId: string,
  ) {}

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return d1Query<T>(this.client, this.accountId, this.databaseId, sql, params);
  }

  importSql(sqlText: string) {
    return d1Import(this.client, this.accountId, this.databaseId, sqlText);
  }
}

/** 建控制面：core 库（module_registry/setup_tokens 所在）。 */
export function createCoreControlPlane(client: RestClient, accountId: string, coreDbId: string): ControlPlane {
  return new RestD1ControlPlane(new RestExecutor(client, accountId, coreDbId));
}
