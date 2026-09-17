// SPDX-License-Identifier: AGPL-3.0-only
/**
 * D1 REST（#65）：query（?N 序号参数）/ create / list / import（init→PUT→poll 三段式）。
 * import 形状实测（wrangler 4.129.0 源码 + 2026-09-17 真机探针）：
 * - POST /d1/database/{id}/import {action:'init', etag: md5(sqlText)} → {upload_url, at_bookmark}；
 *   同 etag 重复 init 不回 upload_url（服务端按内容去重 = 幂等）；
 * - 原始字节 PUT upload_url（Content-length 必带）→ 首个 poll 响应；
 * - POST {action:'poll', current_bookmark} 直到 status === 'complete' | 'error'。
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

/** SQL 文本导入（建表/迁移）：init(md5 etag) → 原始 PUT → poll 到 complete。 */
export async function d1Import(
  client: RestClient,
  accountId: string,
  databaseId: string,
  sqlText: string,
): Promise<ImportReport> {
  const etag = createHash('md5').update(sqlText).digest('hex');
  const init = await client.request<{
    upload_url?: string;
    at_bookmark?: string;
    status?: string;
    num_queries?: number;
    final_bookmark?: string;
  }>('POST', `/accounts/${accountId}/d1/database/${databaseId}/import`, {
    body: JSON.stringify({ action: 'init', etag }),
  });
  let status = init.result.status;
  let atBookmark = init.result.at_bookmark;
  let numQueries = init.result.num_queries ?? 0;
  let finalBookmark = init.result.final_bookmark ?? '';

  if (init.result.upload_url) {
    const bytes = new TextEncoder().encode(sqlText);
    const raw = await rawPut(init.result.upload_url, bytes, client);
    status = raw.status;
    atBookmark = raw.at_bookmark;
    if (raw.num_queries !== undefined) numQueries = raw.num_queries;
    if (raw.final_bookmark) finalBookmark = raw.final_bookmark;
  }

  let guard = 0;
  while (status && status !== 'complete' && status !== 'error') {
    if (++guard > 200) throw new Error(`D1 import 轮询超过 ${guard} 次未完成（bookmark=${atBookmark}）`);
    const poll = await client.request<{
      status?: string;
      at_bookmark?: string;
      num_queries?: number;
      final_bookmark?: string;
      errors?: string[];
    }>('POST', `/accounts/${accountId}/d1/database/${databaseId}/import`, {
      body: JSON.stringify({ action: 'poll', current_bookmark: atBookmark }),
    });
    if (poll.result.status === 'error') {
      throw new Error(`D1 import 失败：${(poll.result.errors ?? []).join('; ') || '未知错误'}`);
    }
    status = poll.result.status;
    atBookmark = poll.result.at_bookmark;
    if (poll.result.num_queries !== undefined) numQueries = poll.result.num_queries;
    if (poll.result.final_bookmark) finalBookmark = poll.result.final_bookmark;
  }
  if (status === 'error') {
    throw new Error('D1 import 失败（服务端报 error，无明细）');
  }
  return { numQueries, finalBookmark };
}

/** presigned PUT（R2 入口）：二进制体 + Content-length；响应为首个 poll 形状或空。 */
async function rawPut(url: string, body: Uint8Array, client: RestClient): Promise<{
  status?: string;
  at_bookmark?: string;
  num_queries?: number;
  final_bookmark?: string;
}> {
  // 走注入的 fetchImpl（测试）；presigned URL 带授权查询串，不再加 Authorization 头
  const res = await client.fetchImpl(url, { method: 'PUT', headers: { 'Content-length': String(body.length) }, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`D1 import 上传失败：HTTP ${res.status} ${text.slice(0, 160)}`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as { status?: string; at_bookmark?: string };
  } catch {
    return {};
  }
}

/** 型别信封再导出（import 兼容）。 */
export type { CfEnvelope };
