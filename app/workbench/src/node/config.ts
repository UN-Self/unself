// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node 运行体配置（#360）：环境变量 → 结构化配置，纯解析、无副作用。
 *
 * 两参数启动 + 可选：
 * - `UNSELF_DB`：`sqlite:///abs/path.db` | `sqlite://:memory:` | `postgres://…`
 * - `UNSELF_FILES`：`local:/abs/dir` | `s3://bucket?endpoint=…&region=…&accessKeyId=…&secretAccessKey=…`
 *   （不配 = 头像能力关闭，与 R2 未绑定的现状同义）
 * - `UNSELF_ADDR`（默认 `0.0.0.0:8787`）、`UNSELF_DATA_DIR`（默认 `/app/data`）、
 *   `UNSELF_BASE_URL`（setup 深链接用，缺省按 localhost）。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type DatabaseConfig =
  | { kind: 'sqlite'; path: string }
  | { kind: 'postgres'; url: string };

export type FilesConfig =
  | { kind: 'local'; dir: string }
  | {
      kind: 's3';
      bucket: string;
      endpoint: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };

export interface NodeConfig {
  database: DatabaseConfig;
  files: FilesConfig | null;
  host: string;
  port: number;
  dataDir: string;
  baseUrl: string | null;
  assetsDir: string;
  migrationsDir: string;
}

/** `sqlite:///abs/path` / `sqlite://:memory:` / `postgres://…`。 */
export function parseDatabaseUrl(value: string): DatabaseConfig {
  if (value.startsWith('postgres://') || value.startsWith('postgresql://')) {
    return { kind: 'postgres', url: value };
  }
  if (value.startsWith('sqlite://')) {
    const rest = value.slice('sqlite://'.length);
    if (rest === ':memory:' || rest === '') return { kind: 'sqlite', path: ':memory:' };
    // `sqlite:///abs/path` 的 rest 是 `/abs/path`；相对路径不接（数据目录必须是明确落点）。
    if (!rest.startsWith('/')) {
      throw new Error(`UNSELF_DB 的 sqlite 路径必须是绝对路径：${value}`);
    }
    return { kind: 'sqlite', path: rest };
  }
  throw new Error(`UNSELF_DB 未知方言（支持 sqlite:// 与 postgres://）：${value}`);
}

/** `local:/abs/dir` / `s3://bucket?endpoint=…`（未设/空串 = 关闭）。 */
export function parseFilesSpec(value: string | undefined): FilesConfig | null {
  if (!value) return null;
  if (value.startsWith('local:')) {
    let dir = value.slice('local:'.length);
    if (dir.startsWith('//')) dir = dir.slice(2);
    if (!dir.startsWith('/')) throw new Error(`UNSELF_FILES 的 local 路径必须是绝对路径：${value}`);
    return { kind: 'local', dir };
  }
  if (value.startsWith('s3://')) {
    const url = new URL(value);
    const bucket = url.hostname;
    const endpoint = url.searchParams.get('endpoint');
    const accessKeyId = url.searchParams.get('accessKeyId') ?? '';
    const secretAccessKey = url.searchParams.get('secretAccessKey') ?? '';
    if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error('UNSELF_FILES 的 s3 形态必须带 bucket 与 endpoint/accessKeyId/secretAccessKey 查询参数');
    }
    const forcePathStyle = ['1', 'true', 'yes'].includes((url.searchParams.get('forcePathStyle') ?? '').toLowerCase());
    return {
      kind: 's3',
      bucket,
      endpoint,
      region: url.searchParams.get('region') ?? 'us-east-1',
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
    };
  }
  throw new Error(`UNSELF_FILES 未知 scheme（支持 local:/ 与 s3://）：${value}`);
}

/** `0.0.0.0:8787` / `:8787` / `8787` / `[::1]:8787` → host + port。 */
export function parseAddr(value: string): { host: string; port: number } {
  const trimmed = value.trim();
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(trimmed);
  if (match) return { host: match[1]!, port: Number(match[2]) };
  const idx = trimmed.lastIndexOf(':');
  const host = idx < 0 ? '0.0.0.0' : trimmed.slice(0, idx) || '0.0.0.0';
  const portText = idx < 0 ? trimmed : trimmed.slice(idx + 1);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`UNSELF_ADDR 端口非法：${value}`);
  }
  return { host, port };
}

/** 包根定位：源码 `src/` 与打包产物 `dist/node/` 两种层级都向上找 migrations/core。 */
export function resolvePackageRoot(moduleUrl: string): string {
  const here = dirname(moduleUrl.startsWith('file:') ? new URL(moduleUrl).pathname : moduleUrl);
  for (const candidate of [resolve(here, '..'), resolve(here, '..', '..')]) {
    if (existsSync(join(candidate, 'migrations', 'core'))) return candidate;
  }
  throw new Error('找不到包根（migrations/core）；打包产物的目录层级不符合预期');
}

/** 读环境变量（测试可传替身 env）。 */
export function readNodeConfig(env: NodeJS.ProcessEnv, packageRoot: string): NodeConfig {
  const databaseUrl = env.UNSELF_DB ?? 'sqlite:///app/data/core.db';
  const database = parseDatabaseUrl(databaseUrl);
  const addr = parseAddr(env.UNSELF_ADDR ?? '0.0.0.0:8787');
  const files = parseFilesSpec(env.UNSELF_FILES);
  const dataDir = env.UNSELF_DATA_DIR
    ? resolve(env.UNSELF_DATA_DIR)
    : database.kind === 'sqlite' && database.path !== ':memory:'
      ? dirname(database.path)
      : '/app/data';
  return {
    database,
    files,
    host: addr.host,
    port: addr.port,
    dataDir,
    // 空串与纯空白都归一为「未设」：compose 里 `${UNSELF_BASE_URL:-}` 默认传的是空串，
    // 用 ?? 兜不住它（?? 只描 null/undefined），会拼出 `/setup?token=…` 这种相对路径——
    // 用户从终端复制到浏览器直接打不开。归一后走下方 localhost 兑底。
    baseUrl: env.UNSELF_BASE_URL?.trim() || null,
    assetsDir: env.UNSELF_WEB_DIR ? resolve(env.UNSELF_WEB_DIR) : join(packageRoot, 'dist', 'web'),
    migrationsDir: join(packageRoot, 'migrations'),
  };
}
