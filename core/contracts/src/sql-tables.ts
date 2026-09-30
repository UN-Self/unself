// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 迁移 SQL 的结构抓取（单一实现）：**先词法分 token，再在语法位置认标识符**。
 *
 * 为什么不是正则/「剥字符」：SQL 的引号与注释是有词法上下文的——`"-- harmless column"`
 * 是标识符（里面的 `--` 不是行注释）、`'REFERENCES x'` 是字符串（不是关键字）、
 * `[users]`/`"users"`/`` `users` `` 是标识符。任何「无条件删单引号 / 按 `--` 切行」的做法
 * 都会破坏上下文（#310 主会话实测退回：`REFERENCES 'users'` 与 `"-- c" REFERENCES users`
 * 都真实建出跨模块 FK，解析却漏检）。
 *
 * 本模块给 shared 护栏（`shared-guards.ts`）与 `validate.ts` 共用一份解析，避免两张皮。
 * 不支持的**真实语法**（`CREATE TABLE 'x'`、`REFERENCES (` 缺目标、未闭合引号）会进
 * `problems` 明确拒绝，不静默跳过。契约对外可见面仍经 `validate.ts` 具名导出
 * （`tableNamesFromSql`）；`foreignKeyTargets` 经 `shared-guards.ts` 再导出。
 */

/** 词法 token 类型：裸词 / 引号标识符（"…"、`…`、[…]）/ 单引号字符串 / 标点。 */
export type SqlTokenType = 'word' | 'quoted' | 'string' | 'punct';

export interface SqlToken {
  type: SqlTokenType;
  /** 去引号/反转义后的值（标识符或字符串内容）。 */
  value: string;
  /** 原文片段（诊断用）。 */
  raw: string;
}

export interface SqlStructure {
  /** `CREATE TABLE [IF NOT EXISTS] <name>` 里的表名（去引号）。 */
  tables: string[];
  /** `REFERENCES <target>` 里的目标表名（去引号/去引号字符串）。 */
  references: string[];
  /** 不支持的/畸形的语法位置（明确拒绝，不静默跳过）。 */
  problems: string[];
}

const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80;
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;
const isWord = (t: SqlToken | undefined, w: string): boolean =>
  t !== undefined && t.type === 'word' && t.value.toLowerCase() === w;

/**
 * 词法扫描：识别 `--` 行注释、`/* *\/` 块注释、`'…'` 字符串（`''` 转义）、
 * `"…"`（`""` 转义）、`` `…` ``（``` `` ``` 转义）、`[…]`（到首个 `]`）。
 * 注释与空白不进 token 流；未闭合引号/块注释进 problems。
 */
export function tokenizeSql(sql: string): { tokens: SqlToken[]; problems: string[] } {
  const tokens: SqlToken[] = [];
  const problems: string[] = [];
  let i = 0;
  const n = sql.length;

  const readQuoted = (open: string, close: string, doubledEscape: boolean): void => {
    const start = i;
    i += 1;
    let value = '';
    let closed = false;
    while (i < n) {
      const c = sql[i]!;
      if (c === close) {
        if (doubledEscape && sql[i + 1] === close) {
          value += close;
          i += 2;
          continue;
        }
        i += 1;
        closed = true;
        break;
      }
      value += c;
      i += 1;
    }
    if (!closed) problems.push(`未闭合的引号（自 ${open} 起）：${sql.slice(start, Math.min(start + 24, n))}…`);
    tokens.push({ type: 'quoted', value, raw: sql.slice(start, i) });
  };

  while (i < n) {
    const c = sql[i]!;
    // 空白
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    // 行注释
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    // 块注释（SQLite 不嵌套，到首个 */）
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      if (i < n) {
        i += 2;
      } else {
        problems.push(`未闭合的块注释：${sql.slice(start, Math.min(start + 24, n))}…`);
      }
      continue;
    }
    // 单引号字符串（'' 转义）——独立 token，绝不参与关键字匹配
    if (c === "'") {
      const start = i;
      i += 1;
      let value = '';
      let closed = false;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        value += sql[i]!;
        i += 1;
      }
      if (!closed) problems.push(`未闭合的字符串：${sql.slice(start, Math.min(start + 24, n))}…`);
      tokens.push({ type: 'string', value, raw: sql.slice(start, i) });
      continue;
    }
    // 双引号标识符（"" 转义）
    if (c === '"') {
      readQuoted('"', '"', true);
      continue;
    }
    // 反引号标识符（`` 转义）
    if (c === '`') {
      readQuoted('`', '`', true);
      continue;
    }
    // 方括号标识符（SQLite：到首个 ]，无转义）
    if (c === '[') {
      readQuoted('[', ']', false);
      continue;
    }
    // 裸词/关键字
    if (isIdentStart(c)) {
      const start = i;
      i += 1;
      while (i < n && isIdentPart(sql[i]!)) i += 1;
      tokens.push({ type: 'word', value: sql.slice(start, i), raw: sql.slice(start, i) });
      continue;
    }
    // 标点
    tokens.push({ type: 'punct', value: c, raw: c });
    i += 1;
  }
  return { tokens, problems };
}

function snippet(tokens: SqlToken[], from: number): string {
  return tokens
    .slice(from, from + 6)
    .map((t) => t.raw)
    .join(' ');
}

/**
 * 在 token 流上按语法位置抓 `CREATE TABLE` 表名与 `REFERENCES` 目标。
 * - `CREATE TABLE` 名：裸词/引号标识符；单引号字符串等一律视为**不支持的真实语法**→ problems；
 * - `REFERENCES` 目标：裸词/引号标识符，且 SQLite 也接受单引号字符串作表名 → 一并接受；
 * - 语法位置缺目标 / `IF` 子句残缺 / 未闭合引号 → problems（调用方必须拒绝，不静默跳过）。
 */
export function parseSqlStructure(sql: string): SqlStructure {
  const { tokens, problems } = tokenizeSql(sql);
  const tables = new Set<string>();
  const references = new Set<string>();
  const outProblems = [...problems];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    if (isWord(t, 'create')) {
      let j = i + 1;
      if (isWord(tokens[j], 'temp') || isWord(tokens[j], 'temporary')) j += 1;
      // 不支持虚拟表（#310 复验 #5）：`CREATE VIRTUAL TABLE … USING fts5/…` 会连带建影子表
      // （foreign_search + *_data/_idx/_content/_docsize/_config），无法用 tables 清单申报，
      // 也不能当成普通建表静默跳过——显式拒绝。
      if (isWord(tokens[j], 'virtual')) {
        let k = j + 1;
        if (isWord(tokens[k], 'table')) {
          k += 1;
          if (isWord(tokens[k], 'if') && isWord(tokens[k + 1], 'not') && isWord(tokens[k + 2], 'exists')) k += 3;
          const vName = tokens[k];
          const vText = vName && (vName.type === 'word' || vName.type === 'quoted') ? vName.value : '(未识别)';
          outProblems.push(
            `不支持虚拟表（CREATE VIRTUAL TABLE ${vText} …）：其影子表无法用 tables 清单申报；shared 需普通表`,
          );
        }
        continue;
      }
      if (!isWord(tokens[j], 'table')) continue; // CREATE VIEW/INDEX/… 与本解析无关
      j += 1;
      if (isWord(tokens[j], 'if')) {
        if (isWord(tokens[j + 1], 'not') && isWord(tokens[j + 2], 'exists')) {
          j += 3;
        } else {
          outProblems.push(`CREATE TABLE 的 IF 子句不完整：${snippet(tokens, i)}`);
        }
      }
      const name = tokens[j];
      if (name && (name.type === 'word' || name.type === 'quoted')) {
        tables.add(name.value);
      } else {
        outProblems.push(`CREATE TABLE 后不是可识别的表名（不支持的真实语法）：${snippet(tokens, i)}`);
      }
      continue;
    }

    if (isWord(t, 'references')) {
      let target = tokens[i + 1];
      // schema 限定 `schema.table`：取点号后的标识符作目标
      if (
        target &&
        (target.type === 'word' || target.type === 'quoted') &&
        tokens[i + 2]?.type === 'punct' &&
        tokens[i + 2]!.value === '.' &&
        (tokens[i + 3]?.type === 'word' || tokens[i + 3]?.type === 'quoted')
      ) {
        target = tokens[i + 3];
      }
      if (target && target.type !== 'punct') {
        references.add(target.value);
      } else {
        outProblems.push(`REFERENCES 后缺可识别目标（不支持的真实语法）：${snippet(tokens, i)}`);
      }
      continue;
    }
  }
  return { tables: [...tables], references: [...references], problems: outProblems };
}

/** 从 SQL 文本抓全部建表表名（去重）。 */
export function tableNamesFromSql(sql: string): string[] {
  return parseSqlStructure(sql).tables;
}

/** 抓 `REFERENCES` 的目标表名（去重）。 */
export function foreignKeyTargets(sql: string): string[] {
  return parseSqlStructure(sql).references;
}

/** 不支持/畸形的语法位置（发布期与装配期据此明确拒绝）。 */
export function sqlParseProblems(sql: string): string[] {
  return parseSqlStructure(sql).problems;
}
