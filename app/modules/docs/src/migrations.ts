// SPDX-License-Identifier: AGPL-3.0-only
/**
 * docs 模块的迁移清单（#358 T2）：SQL 以文本方式打进产物，启动时交给 migrate.ts 逐份应用。
 *
 * 构建约定（T1 对齐点）：worker 侧 esbuild 需配置 `loader: { '.sql': 'text' }`；
 * node 侧若走 node:sqlite 也可以直接读磁盘文件，但两边必须用同一份清单与记账键。
 * 新增迁移 = 在 migrations/docs/ 放文件 + 在这里补一行，顺序以文件名为准。
 */
import baseline from '../migrations/docs/0001_baseline.sql';

import type { D1Executable } from './d1';
import { applyMigrations, type MigrationFile, type MigrationOutcome } from './migrate';

export const DOCS_MIGRATIONS: readonly MigrationFile[] = [{ name: '0001_baseline.sql', sql: baseline }];

/** 启动时调用：建账本 → 跳过已记账文件 → 应用缺失的迁移。 */
export function applyDocsMigrations(db: D1Executable): Promise<MigrationOutcome> {
  return applyMigrations(db, DOCS_MIGRATIONS);
}
