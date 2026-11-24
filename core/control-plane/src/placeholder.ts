// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 占位符方言改写（#360 轨道 B）：SQLite/D1 的 `?` 系占位符 → PostgreSQL 的 `$N`。
 *
 * 为什么单独成文件：sql.ts 是控制面 SQL 单点（`?N` 序号形式），workbench 路由层
 * 另有八十余处内联 SQL 用匿名 `?`（D1 与 node:sqlite 都吃）。两种写法都是业务
 * 侧的合法 SQL，PG 驱动只认 `$N`——差异全部在这个边界吃掉，业务 SQL 一行不动
 * （用户定案「走 adapter」：模块不该关心背后连的是什么库）。
 *
 * 改写规则（与 SQLite 的占位符语义逐条对齐，#103①）：
 * - `?N` → `$N`，原位改写、不重排。同一 `?N` 多处引用时都变成 `$N`，pg 按位置
 *   绑定，bind 数不变（sql.ts 的 REGISTRY_UPSERT_SQL 里 `?5` 出现三次）；
 * - 匿名 `?` → 按出现顺序编号。**编号从「本句已有的最大 ?N」之后接起**，这是
 *   SQLite 的真实语义（匿名 `?` 取当前最大编号 + 1）；`WHERE a = ? AND b = ?2`
 *   在 SQLite 里 a 绑第 3 个参数，改写后必须是 `$3`，否则与 `$2` 撞车。
 *   现仓没有混用，但规则按语义写，不赌以后没人写；
 * - `?` 后面跟非数字且非空白/结束（如 jsonb 的 `?`、`?|` 操作符）原样保留。
 *
 * 跳过三类「不是占位符」的 `?`：单引号字符串（`''` 转义）、双引号标识符
 * （`""` 转义）、行注释 `--` 与块注释（PG 允许嵌套，按嵌套处理）。
 */
export function toPgPlaceholders(sql: string): string {
  const maxIndexed = highestIndexedPlaceholder(sql);
  return rewrite(sql, maxIndexed);
}

/** 第一遍：本句里 `?N` 的最大 N（没有则 0）。匿名占位符从它之后接起。 */
function highestIndexedPlaceholder(sql: string): number {
  let max = 0;
  let i = 0;
  while (i < sql.length) {
    const skipped = skipNonCode(sql, i);
    if (skipped > i) {
      i = skipped;
      continue;
    }
    const ch = sql[i]!;
    const digits = ch === '?' ? readDigits(sql, i + 1) : '';
    if (digits) max = Math.max(max, Number(digits));
    i += 1;
  }
  return max;
}

/** 第二遍：按规则改写。anonymous 计数从 maxIndexed 起，遇到匿名 `?` 先加再写。 */
function rewrite(sql: string, maxIndexed: number): string {
  let out = '';
  let anonymous = maxIndexed;
  let i = 0;
  while (i < sql.length) {
    const skipped = skipNonCode(sql, i);
    if (skipped > i) {
      out += sql.slice(i, skipped);
      i = skipped;
      continue;
    }
    const ch = sql[i]!;
    if (ch === '?') {
      const digits = readDigits(sql, i + 1);
      if (digits) {
        out += `$${digits}`;
        i += 1 + digits.length;
        continue;
      }
      // 匿名占位符 vs jsonb 操作符：后者后面紧跟非空白字符（`?|`、`?&`）或就是操作数本身。
      // SQL 里匿名 `?` 后面只会跟空白、`)`、`,`、`;` 或行尾；其余一律不当占位符。
      const next = i + 1 < sql.length ? sql[i + 1]! : '';
      if (next === '' || /[\s),;]/.test(next)) {
        anonymous += 1;
        out += `$${anonymous}`;
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 从 i 起若是字符串/注释，返回跳过后的下标；否则返回 i（未跳过）。 */
function skipNonCode(sql: string, i: number): number {
  const ch = sql[i]!;
  const next = i + 1 < sql.length ? sql[i + 1]! : '';
  if (ch === "'" || ch === '"') return skipQuoted(sql, i, ch);
  if (ch === '-' && next === '-') {
    const newline = sql.indexOf('\n', i);
    return newline === -1 ? sql.length : newline;
  }
  if (ch === '/' && next === '*') return skipBlockComment(sql, i);
  return i;
}

/** 从 start 处读连续数字，直到非数字；空串表示没有。 */
function readDigits(sql: string, start: number): string {
  let end = start;
  while (end < sql.length && sql[end]! >= '0' && sql[end]! <= '9') end += 1;
  return sql.slice(start, end);
}

/** 从 start 处的引号起吞到闭合引号之后；成对引号为转义。未闭合则吞到末尾。 */
function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

/** 从 start 处的 `/*` 起吞到配对 `*\/` 之后（支持嵌套）；未闭合则吞到末尾。 */
function skipBlockComment(sql: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      depth += 1;
      i += 2;
      continue;
    }
    if (sql[i] === '*' && sql[i + 1] === '/') {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return sql.length;
}
