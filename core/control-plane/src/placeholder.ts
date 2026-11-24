// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 占位符方言改写（#360 轨道 B）：`?N` 序号占位符 → PostgreSQL 的 `$N`。
 *
 * 为什么单独成文件：sql.ts 是 SQL 单点（D1 与 node:sqlite 都吃 ?N），PG 驱动只认 $N。
 * 改写只发生在 PG 执行器边界，SQL 原文不动（三实现共用的防漂移前提不变）。
 *
 * 跳过三类「不是占位符」的 ?：
 * - 单引号字符串（`''` 转义）；
 * - 双引号标识符（`""` 转义，标识符里也能出现 ?）；
 * - 行注释 `--` 与块注释（PG 允许块注释嵌套，按嵌套处理）。
 * `?` 后面不是数字时原样保留（如 jsonb 的 `?` 操作符）。
 */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = i + 1 < sql.length ? sql[i + 1]! : '';
    if (ch === "'") {
      const end = skipQuoted(sql, i, "'");
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '"') {
      const end = skipQuoted(sql, i, '"');
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '-' && next === '-') {
      const newline = sql.indexOf('\n', i);
      const end = newline === -1 ? sql.length : newline;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = skipBlockComment(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '?' && next >= '0' && next <= '9') {
      out += '$';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
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
