// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Workers REST（#65）：脚本上传（module syntax multipart）/ secret list+put /
 * workers.dev 子域启用 / 部署产物下载（secret 同步上传后的整包重传用）。
 * multipart 形状实测（wrangler 4.129.0 createWorkerUploadForm + 2026-09-17 真机探针）：
 *   字段 metadata = JSON 字符串（main_module/bindings/...），模块文件以 **文件名** 为字段名。
 */
import type { CfEnvelope, RestClient } from './client';

export interface WorkerBinding {
  type: string;
  name: string;
  [key: string]: unknown;
}

export interface WorkerUpload {
  name: string;
  /** ESM 主模块入口文件名（metadata.main_module）。 */
  mainModule: string;
  modules: Array<{ name: string; content: string; contentType?: string }>;
  bindings?: WorkerBinding[];
  compatibilityDate: string;
  compatibilityFlags?: string[];
  observability?: boolean;
  /** DO 迁移元数据（chat 首部署建 SQLite 类；形状实测 wrangler 4.129.0）。 */
  migrations?: {
    oldTag?: string;
    newTag: string;
    steps: Array<Record<string, unknown>>;
  };
}

const ESM_TYPE = 'application/javascript+module';

export async function putWorker(client: RestClient, accountId: string, upload: WorkerUpload): Promise<CfEnvelope<unknown>> {
  const metadata: Record<string, unknown> = {
    main_module: upload.mainModule,
    compatibility_date: upload.compatibilityDate,
    ...(upload.compatibilityFlags?.length ? { compatibility_flags: upload.compatibilityFlags } : {}),
    ...(upload.bindings?.length ? { bindings: upload.bindings } : {}),
    ...(upload.observability ? { observability: { enabled: true } } : {}),
    ...(upload.migrations
      ? {
          migrations: {
            old_tag: upload.migrations.oldTag,
            new_tag: upload.migrations.newTag,
            steps: upload.migrations.steps,
          },
        }
      : {}),
  };
  const form = new FormData();
  form.set('metadata', JSON.stringify(metadata));
  for (const mod of upload.modules) {
    form.set(
      mod.name,
      new Blob([mod.content], { type: mod.contentType ?? ESM_TYPE }),
      mod.name,
    );
  }
  return client.putMultipart(`/accounts/${accountId}/workers/scripts/${upload.name}`, form);
}

/** 首部署判定：脚本不存在（404）→ DO migrations 元数据可带；已部署 → 省略（幂等重传）。 */
export async function isWorkerNew(client: RestClient, accountId: string, name: string): Promise<boolean> {
  try {
    await getWorkerSettings(client, accountId, name);
    return false;
  } catch {
    return true;
  }
}

export async function deleteWorker(client: RestClient, accountId: string, name: string): Promise<void> {
  await client.delete(`/accounts/${accountId}/workers/scripts/${name}`);
}

export async function listWorkers(client: RestClient, accountId: string): Promise<Array<{ id: string }>> {
  const res = await client.get<Array<{ id: string }>>(`/accounts/${accountId}/workers/scripts`);
  return res.result ?? [];
}

/** Worker 设置（bindings 快照；secret 探测 = settings 里 type=secret_text 的 name）。 */
export async function getWorkerSettings(
  client: RestClient,
  accountId: string,
  name: string,
): Promise<{ bindings: WorkerBinding[] }> {
  const res = await client.get<{ bindings: WorkerBinding[] }>(`/accounts/${accountId}/workers/scripts/${name}/settings`);
  return { bindings: res.result?.bindings ?? [] };
}

export async function hasWorkerSecret(client: RestClient, accountId: string, name: string, secretName: string): Promise<boolean> {
  try {
    const settings = await getWorkerSettings(client, accountId, name);
    return settings.bindings.some((b) => b.type === 'secret_text' && b.name === secretName);
  } catch {
    // Worker 不存在（首次部署）→ 视为缺失
    return false;
  }
}

export async function putWorkerSecret(
  client: RestClient,
  accountId: string,
  name: string,
  secretName: string,
  value: string,
): Promise<void> {
  await client.put(`/accounts/${accountId}/workers/scripts/${name}/secrets`, {
    name: secretName,
    text: value,
    type: 'secret_text',
  });
}

/** workers.dev 子域（账号级）+ 启用本 Worker 的子域访问。 */
export async function workersDevSubdomain(client: RestClient, accountId: string): Promise<string | null> {
  const res = await client.get<{ subdomain: string }>(`/accounts/${accountId}/workers/subdomain`);
  return res.result?.subdomain ?? null;
}

export async function enableWorkersDev(client: RestClient, accountId: string, name: string): Promise<void> {
  await client.post(`/accounts/${accountId}/workers/scripts/${name}/subdomain`, { enabled: true });
}
