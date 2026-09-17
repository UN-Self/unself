// SPDX-License-Identifier: AGPL-3.0-only
/**
 * R2 / KV REST（#65）：桶与命名空间的查漏补建（真机探针实测形状）。
 * R2 list：result.buckets[]；create/delete：/r2/buckets/{name}；
 * KV list：result[]（{id,title}）；create：POST /storage/kv/namespaces {title}。
 */
import type { RestClient } from './client';

export async function r2ListBuckets(client: RestClient, accountId: string): Promise<string[]> {
  const res = await client.get<{ buckets: Array<{ name: string }> }>(`/accounts/${accountId}/r2/buckets`);
  return (res.result?.buckets ?? []).map((b) => b.name);
}

export async function ensureR2Bucket(
  client: RestClient,
  accountId: string,
  bucket: string,
  log: (m: string) => void,
): Promise<'exists' | 'created'> {
  const names = await r2ListBuckets(client, accountId);
  if (names.includes(bucket)) {
    log(`R2 桶 ${bucket} 已存在`);
    return 'exists';
  }
  await client.post(`/accounts/${accountId}/r2/buckets`, { name: bucket });
  log(`R2 桶 ${bucket} 已创建`);
  return 'created';
}

export async function deleteR2Bucket(client: RestClient, accountId: string, bucket: string): Promise<void> {
  await client.delete(`/accounts/${accountId}/r2/buckets/${bucket}`);
}

export interface KvNamespace {
  id: string;
  title: string;
}

export async function kvList(client: RestClient, accountId: string): Promise<KvNamespace[]> {
  const res = await client.get<KvNamespace[]>(`/accounts/${accountId}/storage/kv/namespaces`);
  return res.result ?? [];
}

export async function ensureKvNamespace(
  client: RestClient,
  accountId: string,
  title: string,
  log: (m: string) => void,
): Promise<string> {
  const list = await kvList(client, accountId);
  const found = list.find((ns) => ns.title === title);
  if (found) {
    log(`KV ${title} 已存在（${found.id}）`);
    return found.id;
  }
  const res = await client.post<KvNamespace>(`/accounts/${accountId}/storage/kv/namespaces`, { title });
  log(`KV ${title} 已创建（${res.result.id}）`);
  return res.result.id;
}

export async function deleteKvNamespace(client: RestClient, accountId: string, id: string): Promise<void> {
  await client.delete(`/accounts/${accountId}/storage/kv/namespaces/${id}`);
}
