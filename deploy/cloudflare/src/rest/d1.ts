// SPDX-License-Identifier: AGPL-3.0-only
/**
 * D1 REST（#65）：query（?N 序号参数）/ create / list / import（init→PUT→**ingest**→poll 四段式）。
 * import 形状实测（CF REST v4 + wrangler 4.129.1 源码，2026-09-18 真机探针）：
 * - POST /d1/database/{id}/import {action:'init', etag: md5(bytes)} → {success, filename, upload_url}；
 *   同 etag 重复 init 不回 upload_url（服务端按内容去重 = 幂等）；
 * - 原始字节 PUT upload_url（Content-length 必带）→ HTTP 200 空体 + ETag 响应头；
 * - POST {action:'ingest', filename, etag} → {status, at_bookmark, result:{num_queries,…}}；
 * - POST {action:'poll', current_bookmark} 直到 status === 'complete' | 'error'。
 *   缺 ingest 时 init/PUT 都 200 但 SQL 不执行（#257 真机实测：记账写了、表没建）。
 * 记账不依赖 d1_migrations：按模块独立记账表（packages/control-plane）。
 */
import { createHash } from 'node:crypto';
import type { CfEnvelope, RestClient } from './client';

export interface D1Database {
  name: string;
  uuid: string;
}

/** 查询行集（/query 响应 result 为数组，每元素 {results, success, meta}）。 */
export interface QueryResult<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number; duration: number };
}

export async function d1List(client: RestClient, accountId: string): Promise<D1Database[]> {
  const res = await client.get<D1Database[]>(`/accounts/${accountId}/d1/database`);
  return res.result ?? [];
}

export async function d1Create(client: RestClient, accountId: string, name: string): Promise<D1Database> {
  const res = await client.post<D1Database>(`/accounts/${accountId}/d1/database`, { name });
  return res.result;
}

/** 查漏补建：按名找到 → 返回既有；不存在 → 创建（并发撞车 → 回查自愈）。 */
export async function ensureD1(client: RestClient, accountId: string, name: string, log: (m: string) => void): Promise<string> {
  const list = await d1List(client, accountId);
  const found = list.find((db) => db.name === name);
  if (found) {
    log(`D1 ${name} 已存在（${found.uuid}）`);
    return found.uuid;
  }
  try {
    const created = await d1Create(client, accountId, name);
    log(`D1 ${name} 已创建（${created.uuid}）`);
    return created.uuid;
  } catch (err) {
    // 并发/瞬时：回查列表自愈
    const again = await d1List(client, accountId);
    const refound = again.find((db) => db.name === name);
    if (refound) {
      log(`D1 ${name} 已存在（列表重查 ${refound.uuid}）`);
      return refound.uuid;
    }
    throw err;
  }
}

/** 参数化查询（params 走 ?N 序号占位符；D1 服务端绑定，无字符串内联）。 */
export async function d1Query<T = Record<string, unknown>>(
  client: RestClient,
  accountId: string,
  databaseId: string,
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  const res = await client.post<Array<QueryResult<T>>>(`/accounts/${accountId}/d1/database/${databaseId}/query`, {
    sql,
    params,
  });
  const first = res.result[0];
  if (!first) {
    return { results: [], meta: { changes: 0, duration: 0 } };
  }
  return first;
}

export interface ImportReport {
  numQueries: number;
  finalBookmark: string;
}

/**
 * /import 端点的响应形状（init / ingest / poll 三种 action 共用信封）。
 *
 * **形状实测（2026-09-18，CF REST v4，wrangler 4.129.1 同款三段式）**：
 * - init → `{ success, filename, upload_url }`（**没有** status/at_bookmark）；同 etag 已上传过则直接回 poll 形状；
 * - PUT presigned URL → HTTP 200 空体 + `ETag: "<md5>"` 响应头；
 * - **ingest** `{ action:'ingest', filename, etag }` → `{ status, at_bookmark, result:{num_queries, final_bookmark} }`；
 * - poll `{ action:'poll', current_bookmark }` → 同上，直到 status=complete|error。
 *
 * #257 真机教训（旧实现缺 ingest）：init+PUT 都 200，但 SQL **从未执行**——
 * 记账表写了「已应用」、表没建，干净机器上表现为步骤⑤ upsert 撞 `no such table`。
 */
interface ImportResponse {
  success?: boolean;
  status?: string;
  at_bookmark?: string;
  filename?: string;
  upload_url?: string;
  num_queries?: number;
  final_bookmark?: string;
  errors?: string[];
  result?: { num_queries?: number; final_bookmark?: string };
}

/** SQL 文本导入（建表/迁移）：init(md5 etag) → 原始 PUT → ingest → poll 到 complete。
 *  任何一步没走到 `status="complete"` 都**抛错**（宁停下也不把「可能没跑完」记成已应用）。 */
export async function d1Import(
  client: RestClient,
  accountId: string,
  databaseId: string,
  sqlText: string,
): Promise<ImportReport> {
  const bytes = new TextEncoder().encode(sqlText);
  const etag = createHash('md5').update(bytes).digest('hex');
  const url = `/accounts/${accountId}/d1/database/${databaseId}/import`;
  const post = async (body: Record<string, unknown>): Promise<ImportResponse> =>
    (await client.request<ImportResponse>('POST', url, { body: JSON.stringify(body) })).result ?? {};

  const init = await post({ action: 'init', etag });
  let poll = init;
  if (init.upload_url) {
    const put = await rawPut(init.upload_url, bytes, client);
    // 内容完整性：presigned PUT 回的 ETag = 上传字节 md5（wrangler 同款校验）
    if (put.etag) {
      const got = put.etag.replace(/^"|"$/g, '');
      if (got !== etag) {
        throw new Error(`D1 import 上传内容校验失败：ETag ${got} ≠ md5(${bytes.length}B)=${etag}——重试`);
      }
    }
    if (!init.filename) {
      throw new Error('D1 import init 未返回 filename，无法 ingest——CF REST /import 形状已漂移，请按当前实测重定形状');
    }
    // **必须显式 ingest**：只 PUT 不 ingest 时服务端不执行 SQL（旧实现就在这一步静默丢迁移）
    poll = await post({ action: 'ingest', filename: init.filename, etag });
  }

  let guard = 0;
  while (poll.status && poll.status !== 'complete' && poll.status !== 'error') {
    if (++guard > 200) throw new Error(`D1 import 轮询超过 ${guard} 次未完成（bookmark=${poll.at_bookmark}）`);
    if (!poll.at_bookmark) {
      throw new Error('D1 import 轮询缺 at_bookmark（CF REST /import 形状已漂移，请按当前实测重定形状）');
    }
    poll = await post({ action: 'poll', current_bookmark: poll.at_bookmark });
  }
  if (poll.status === 'error') {
    throw new Error(`D1 import 失败：${(poll.errors ?? []).join('; ') || '未知错误'}`);
  }
  if (poll.status !== 'complete') {
    throw new Error(
      `D1 import 未返回 status="complete"（实际 ${String(poll.status)}）——拒绝把「可能没执行」记成已应用；` +
        '若 CF 又改了 /import 形状，先按实测重定形状再跑',
    );
  }
  return {
    numQueries: poll.result?.num_queries ?? poll.num_queries ?? 0,
    finalBookmark: poll.result?.final_bookmark ?? poll.final_bookmark ?? '',
  };
}

/** presigned PUT（R2 入口）：二进制体 + Content-length；回 ETag（内容完整性校验用）。 */
async function rawPut(url: string, body: Uint8Array, client: RestClient): Promise<{ etag?: string }> {
  const res = await client.fetchImpl(url, {
    method: 'PUT',
    headers: { 'Content-length': String(body.length) },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`D1 import 上传失败：HTTP ${res.status} ${text.slice(0, 160)}`);
  }
  const etag = res.headers.get('etag') ?? undefined;
  if (etag === undefined) return {};
  return { etag };
}

/** 型别信封再导出（import 兼容）。 */
export type { CfEnvelope };
