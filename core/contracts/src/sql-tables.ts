// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 迁移 SQL 的表名抓取（单一实现）。
 *
 * 提取到独立模块是为了让 shared 护栏（`shared-guards.ts`）与 `validate.ts` 共用一份解析，
 * 避免「解析建表语句」出现两份实现漂移（AGENTS 两张皮教训）。契约对外可见面仍经
 * `validate.ts` 具名导出（`tableNamesFromSql`），index 不直接再导出本模块。
 */

/** 建表 SQL 的 CREATE TABLE 表名抓取（容忍引号、IF NOT EXISTS、schema 修饰省略）。 */
export const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi;

/** 从 SQL 文本抓全部建表表名（去重）。 */
export function tableNamesFromSql(sql: string): string[] {
  const names = new Set<string>();
  for (const match of sql.matchAll(CREATE_TABLE_RE)) {
    names.add(match[1]!);
  }
  return [...names];
}
