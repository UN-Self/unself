// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #310 新增（unself 集成层，非上游件）：worker env 单一包装点。
 *
 * 两件事都只在这一处收口，上游业务件零改动：
 * - DB：shared 落点的表带 `chat_` 前缀，靠 `DB_TABLE_PREFIX` 在 D1 绑定边界做标识符映射
 *   （app/modules/chat/worker/src/db-tables.js）；
 * - FILES：三种来源择一——存在的 R2 绑定直接用；否则若配了 `FILES_S3_*` 则构造 S3 适配器
 *   （files-s3.js）；都没有则保持 undefined（上游判空降级为「无附件能力」）。
 *
 * **不静默回退**：配了 S3 参数但凭据缺失时由 files-s3.js 抛错，不会悄悄退回 R2。
 */
import { applyTablePrefix } from './db-tables.js';
import { createS3Files } from './files-s3.js';

/** 由 env 选一个 FILES 来源。 */
export function createFilesBinding(env) {
  if (env.FILES) return env.FILES;
  if (env.FILES_S3_ENDPOINT) {
    return createS3Files({
      endpoint: env.FILES_S3_ENDPOINT,
      region: env.FILES_S3_REGION,
      bucket: env.FILES_S3_BUCKET,
      accessKeyId: env.FILES_S3_ACCESS_KEY_ID,
      secretAccessKey: env.FILES_S3_SECRET_ACCESS_KEY
    });
  }
  return undefined;
}

/** 包装 env：DB 加表名前缀、FILES 按来源择一。无变化时原样返回。 */
export function wrapEnv(env) {
  const db = applyTablePrefix(env.DB, env.DB_TABLE_PREFIX);
  const files = createFilesBinding(env);
  if (db === env.DB && files === env.FILES) return env;
  return { ...env, DB: db, FILES: files };
}
