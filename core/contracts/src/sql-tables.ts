// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 迁移 SQL 的标识符抓取（单一实现）。
 *
 * 提取到独立模块是为了让 shared 护栏（`shared-guards.ts`）与 `validate.ts` 共用一份解析，
 * 避免「解析建表语句」出现两份实现漂移（AGENTS 两张皮教训）。契约对外可见面仍经
 * `validate.ts` 具名导出（`tableNamesFromSql`），index 不直接再导出本模块。
 *
 * 边界（#310 主会话实测退回，Node 24 / SQLite 3.53.4）：
 * - SQLite 接受 `[name]`、`"name"`、`` `name` `` 三种引号标识符；旧实现只认 `"`/`` ` ``，
 *   且把 `CREATE TABLE IF NOT EXISTS [foreign_table]` 回退匹配成表名 `IF`（漏检建表）；
 * - `REFERENCES /* comment *\/ users(id)` 注释夹在关键字与表名之间，旧实现直接漏检；
 * - 字符串字面量/注释里的伪 `REFERENCES`/`CREATE TABLE` 不得当成真实语句。
 * 故先剥离注释与单引号字符串（保留其余标识符引号），再按「关键字 + 标识符（含三种引号）」抓取。
 */

/** 标识符：三种引号形态 + 裸标识符（SQLite 规则：引号内可含任意非闭合字符）。 */
const IDENTIFIER = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_]*)';

/** 建表语句（容忍 IF NOT EXISTS 与标识符引号）。 */
const CREATE_TABLE_RE = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})`, 'gi');

/** 外键目标（容忍标识符引号；注释在剥离阶段已清掉）。 */
const REFERENCES_RE = new RegExp(`REFERENCES\\s+(${IDENTIFIER})`, 'gi');

/**
 * 剥离 SQL 里的注释与单引号字符串字面量（替换为空格，保留换行位置无强要求）。
 * - `--` 行注释到行尾；`/* *\/` 块注释（跨行）；
 * - `'...'` 字符串（`''` 为转义的单引号）。
 * 保留 `"..."` / `` `...` `` / `[...]` —— 它们是标识符，需要参与匹配。
 */
export function stripSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      out += ' ';
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 去掉标识符引号（`[x]` / `"x"` / `` `x` `` → `x`）。 */
function unquoteIdentifier(raw: string): string {
  const first = raw[0];
  if (first === '[' || first === '"' || first === '`') return raw.slice(1, -1);
  return raw;
}

/** 从 SQL 文本抓全部建表表名（去重；先剥离注释/字符串，识别三种引号）。 */
export function tableNamesFromSql(sql: string): string[] {
  const names = new Set<string>();
  for (const match of stripSqlNoise(sql).matchAll(CREATE_TABLE_RE)) {
    names.add(unquoteIdentifier(match[1]!));
  }
  return [...names];
}

/** 抓 `REFERENCES` 的目标表名（去重；先剥离注释/字符串，识别三种引号）。 */
export function foreignKeyTargets(sql: string): string[] {
  const names = new Set<string>();
  for (const match of stripSqlNoise(sql).matchAll(REFERENCES_RE)) {
    names.add(unquoteIdentifier(match[1]!));
  }
  return [...names];
}
