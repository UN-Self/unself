// SPDX-License-Identifier: AGPL-3.0-only
// dev.mjs 的类型声明（供 test/dev-migrations.test.ts 导入纯函数）
export function applyCoreMigrations(
  dbPath: string,
  migrationsDir: string,
  read?: (path: string, encoding: string) => string,
): { applied: string[]; skipped: string[] };
