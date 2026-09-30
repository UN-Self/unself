// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FILES 统一对象存储来源解析（#310）：实例共享桶 / 模块独立桶 / 部署者自备 S3。
 *
 * 设计口径（用户确认 2026-09-30）：
 * - provider=r2 + 落点 shared   → 共享实例桶（`storage.bucket`）；
 * - provider=r2 + 落点 dedicated → 模块独立桶（`unself-<id>-files`）；
 * - provider=s3                → 自备 S3（endpoint/bucket/region 来自 `unself.config.jsonc`，
 *                                凭据走部署进程环境变量，不落 config / unself.lock）。
 *
 * **不静默回退**：配置非法、落点不支持、S3 凭据缺失一律显式失败。
 */
import type { UnselfConfig } from './config';
import type { StorageLevel } from './migrate';
import { resourceName } from './naming';

/** FILES 绑定来源：R2（共享实例桶 / 模块独立桶）或自备 S3。 */
export type FilesSource =
  | { kind: 'r2'; binding: 'FILES'; origin: 'instance' | 'module'; bucket: string }
  | { kind: 's3'; binding: 'FILES'; endpoint: string; region: string; bucket: string };

/** 部署者自备 S3 的凭据（部署进程环境变量；不落 config / lock）。 */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** 自备 S3 凭据环境变量名（模块 secret 名同此，装配期写入 worker secret）。 */
export const S3_ACCESS_KEY_ENV = 'UNSELF_S3_ACCESS_KEY_ID';
export const S3_SECRET_KEY_ENV = 'UNSELF_S3_SECRET_ACCESS_KEY';
/** 写入 worker 的 secret 名（与 worker 读取的 env 属性名一致）。 */
export const S3_ACCESS_SECRET_NAME = 'FILES_S3_ACCESS_KEY_ID';
export const S3_SECRET_SECRET_NAME = 'FILES_S3_SECRET_ACCESS_KEY';

/** 模块独立桶名（与 chat 专属资源同规：`<前缀>unself-<id>-files`）。 */
export function moduleFilesBucket(moduleId: string): string {
  return resourceName(`${moduleId}-files`);
}

/**
 * 解析 FILES 来源。落点 core/external 无对象存储通道（FILES 依赖自建表落点或实例 S3），
 * 直接失败而非回退到另一种存储。
 */
export function resolveFilesSource(input: {
  config: UnselfConfig;
  moduleId: string;
  level: StorageLevel;
}): FilesSource {
  const { config, level, moduleId } = input;
  if (config.storage.provider === 's3') {
    return {
      kind: 's3',
      binding: 'FILES',
      endpoint: config.storage.endpoint,
      region: config.storage.region,
      bucket: config.storage.bucket,
    };
  }
  if (level === 'shared') {
    return { kind: 'r2', binding: 'FILES', origin: 'instance', bucket: config.storage.bucket };
  }
  if (level === 'dedicated') {
    return { kind: 'r2', binding: 'FILES', origin: 'module', bucket: moduleFilesBucket(moduleId) };
  }
  throw new Error(
    `模块 ${moduleId} 落点 ${level} 没有对象存储通道（FILES 需 shared/dedicated 或 storage.provider=s3）——` +
      '拒绝静默回退到另一种来源',
  );
}

/** 自备 S3 凭据：从部署进程环境读；缺任一即显式失败。 */
export function resolveS3Credentials(env: NodeJS.ProcessEnv = process.env): S3Credentials {
  const accessKeyId = env[S3_ACCESS_KEY_ENV];
  const secretAccessKey = env[S3_SECRET_KEY_ENV];
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `storage.provider=s3 需要凭据：环境变量 ${S3_ACCESS_KEY_ENV} / ${S3_SECRET_KEY_ENV} 未提供——` +
        '凭据不落 config/unself.lock，由部署者经环境变量传入',
    );
  }
  return { accessKeyId, secretAccessKey };
}

/** 自备 S3 需要注入 worker 的非密 vars（endpoint/region/bucket）。 */
export function filesSourceVars(source: FilesSource): Record<string, string> {
  if (source.kind !== 's3') return {};
  return {
    FILES_S3_ENDPOINT: source.endpoint,
    FILES_S3_REGION: source.region,
    FILES_S3_BUCKET: source.bucket,
  };
}
