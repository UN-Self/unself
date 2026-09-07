// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cloudflare 资源探测（①⑥）：D1 与 R2 的查漏补建。
 * 一切「已存在则跳过」的判断都基于查询结果，保证重跑收敛（#14 验收）。
 */
import type { UnselfConfig } from './config';
import type { Wrangler } from './wrangler';

/** D1 库描述（wrangler d1 list 输出行）。 */
export interface D1Database {
  name: string;
  uuid: string;
}

export const CORE_DB_NAME = 'unself-core';
export const MODULES_DB_NAME = 'unself-modules';

/** 解析 `wrangler d1 list` 输出（JSON 数组；旧版本降级逐行 name/uuid 文本）。 */
export function parseD1List(stdout: string): D1Database[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((row) => row as Record<string, unknown>)
          .filter((row) => typeof row.name === 'string')
          .map((row) => ({ name: row.name as string, uuid: String(row.uuid ?? '') }));
      }
    } catch {
      // 落到文本解析
    }
  }
  // 文本降级：形如 "unself-core  xxx-uuid" 的行
  const rows: D1Database[] = [];
  for (const line of trimmed.split('\n')) {
    const m = /^\s*(\S+)\s+([0-9a-f-]{36})\s*$/.exec(line);
    if (m) rows.push({ name: m[1]!, uuid: m[2]! });
  }
  return rows;
}

/** 确保两个 D1 存在，返回 name → database_id 映射（步骤①）。 */
export async function ensureDatabases(
  wrangler: Wrangler,
  log: (msg: string) => void = console.log,
): Promise<{ core: string; modules: string }> {
  const res = await wrangler.tryRun(['d1', 'list', '--json']);
  const existing = res.ok ? parseD1List(res.stdout) : [];
  const ids: Record<'core' | 'modules', string> = { core: '', modules: '' };

  for (const [key, name] of [
    ['core', CORE_DB_NAME],
    ['modules', MODULES_DB_NAME],
  ] as const) {
    const found = existing.find((db) => db.name === name);
    if (found?.uuid) {
      ids[key] = found.uuid;
      log(`D1 ${name} 已存在（${found.uuid}）`);
    } else {
      const created = await wrangler.run(['d1', 'create', name, '--json']);
      const parsed = parseD1List(created.stdout);
      const uuid = parsed[0]?.uuid;
      if (!uuid) {
        throw new Error(`D1 ${name} 创建后未返回 database_id，无法继续（原始输出见上方）`);
      }
      ids[key] = uuid;
      log(`D1 ${name} 已创建（${uuid}）`);
    }
  }
  return { core: ids.core!, modules: ids.modules! };
}

/** R2 桶查漏（步骤⑥）：provider=r2 时确保桶存在。 */
export async function ensureR2Bucket(
  wrangler: Wrangler,
  bucket: string,
  log: (msg: string) => void = console.log,
): Promise<'exists' | 'created'> {
  const res = await wrangler.tryRun(['r2', 'bucket', 'list', '--json']);
  if (res.ok) {
    try {
      const parsed: unknown = JSON.parse(res.stdout.trim() || '[]');
      if (Array.isArray(parsed) && parsed.some((b) => (b as Record<string, unknown>).name === bucket)) {
        log(`R2 桶 ${bucket} 已存在`);
        return 'exists';
      }
    } catch {
      // 列表解析失败 → 走创建尝试
    }
  }
  await wrangler.run(['r2', 'bucket', 'create', bucket]);
  log(`R2 桶 ${bucket} 已创建`);
  return 'created';
}

/** 外部 S3 参数校验（步骤⑥的 s3 分支）：缺参数直接失败，不碰 CF。 */
export function validateS3Storage(config: UnselfConfig): void {
  if (config.storage.provider === 's3') {
    if (!config.storage.endpoint || !config.storage.bucket) {
      throw new Error('storage.provider=s3 需要提供 endpoint 与 bucket（unself.config.jsonc）');
    }
  }
}
