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
      // create；「已存在」竞态（瞬时 list 失败走到这）→ catch 后回查列表自愈
      try {
        const created = await wrangler.run(['d1', 'create', name]);
        const createdId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(created.stdout)?.[1]
          ?? parseD1List(created.stdout)[0]?.uuid;
        if (!createdId) {
          throw new Error(`创建输出未含 database_id`);
        }
        ids[key] = createdId;
        log(`D1 ${name} 已创建（${createdId}）`);
      } catch (err) {
        const again = await wrangler.tryRun(['d1', 'list', '--json']);
        const refound = again.ok ? parseD1List(again.stdout).find((db) => db.name === name) : undefined;
        if (!refound?.uuid) {
          throw new Error(`D1 ${name} 创建失败且列表查不到：${err instanceof Error ? err.message : String(err)}`);
        }
        ids[key] = refound.uuid;
        log(`D1 ${name} 已存在（列表重查 ${refound.uuid}）`);
      }
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
  const res = await wrangler.tryRun(['r2', 'bucket', 'list']);
  if (res.ok) {
    try {
      // wrangler v4 的 bucket list 无 --json：成功输出形如 "name:  <桶名>"；JSON 旧形态兼容
      const textNames = [...res.stdout.matchAll(/^name:\s+(\S+)$/gm)].map((m) => m[1]!);
      const jsonNames = (() => {
        const trimmed = res.stdout.trim();
        if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return [] as string[];
        try {
          const parsed: unknown = JSON.parse(trimmed);
          return Array.isArray(parsed)
            ? parsed.map((b) => (b as Record<string, unknown>).name as string).filter(Boolean)
            : [];
        } catch {
          return [];
        }
      })();
      const names = [...new Set([...textNames, ...jsonNames])];
      if (names.includes(bucket)) {
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
