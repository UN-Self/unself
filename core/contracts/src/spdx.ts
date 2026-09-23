// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SPDX 许可证表达式**形状**校验（issue #292）。
 *
 * 用途：manifest 的可选 `license` 字段（SPDX 标识，如 `MIT`）需要在下游
 * （`unself module pack` 写 npm package.json、`unself module validate` 报红）之前
 * 保证是「合法的 SPDX 表达式形状」——否则会把有法律含义的错误信息写进 npm 元数据。
 *
 * **只验形状，不查表**（issue #292 明确边界）：标识符本身是否在 SPDX License List
 * 上（`MIT` yes / `NotALicense` no）不在本模块职责内——那需要随 SPDX 列表更新而更新，
 * 属另一议题。本模块只拒绝语法上不可能成立的表达式。
 *
 * 依据（实测版本）：SPDX Specification v2.3 Annex D「SPDX License Expressions」
 * https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/
 *
 * ABNF（原文）：
 *   idstring            = 1*(ALPHA / DIGIT / "-" / "." )
 *   license-id          = <short form license identifier in Annex A.1>
 *   license-exception-id = <short form license exception identifier in Annex A.2>
 *   license-ref         = ["DocumentRef-"(idstring)":"]"LicenseRef-"(idstring)
 *   simple-expression   = license-id / license-id"+" / license-ref
 *   compound-expression = (simple-expression /
 *                         simple-expression "WITH" license-exception-id /
 *                         compound-expression "AND" compound-expression /
 *                         compound-expression "OR" compound-expression /
 *                         "(" compound-expression ")" )
 *   license-expression  = (simple-expression / compound-expression)
 *
 * 间距规则（原文）：
 *   - `+` 与 license-id 之间**不得**有空白；
 *   - 操作符 `WITH` 两侧**必须**有空白；
 *   - 操作符 `AND` / `OR` 两侧必须有空白和/或括号。
 *
 * 大小写规则（原文）：
 *   - 操作符 `AND` / `OR` / `WITH` **大小写敏感**（小写 `or` 是形状错）；
 *   - 标识符**大小写不敏感**，故形状层不做归一化、不做拼写裁决（见「只验形状」）。
 *
 * 形状 vs 拼写（重要边界）：本模块不查 SPDX License List，因此任何**语法合法**的
 * idstring 都通过——`mitten` / `NotALicense` / `2020` 形状合法即通过，它们是不是
 * 真许可证由列表裁决，不在本层。
 *
 * **由此不可回避的一则边界**：没有 `AND`/`OR` 分隔符的拼接串（如 `MITORApache-2.0`）
 * 本身是一个合法 idstring——形状层与任意合法未知标识符（如 `NotALicense`）**无法区分**，
 * 因此**接受**。这是「只验形状不查表」口径的直接推论，不是漏网：想拒绝它就必须查
 * SPDX 标识表，而查表不在本 issue 范围（会引入需随列表版本维护的数据依赖）。
 * 不得引入「看起来像两个词粘一起就拒」的启发式——那会误杀合法自定义标识符。
 *
 * 与本层确实能拒的相邻形态的区别：`MIT and Apache-2.0` / `MIT or Apache-2.0` 是
 * **由空白分开的三个 idstring**（小写 `and`/`or` 不是操作符），词序列不构成表达式 → 拒。
 *
 * 递归下降解析：语法与 ABNF 逐条对应，越界即返回 false（不抛错——validate 走诊断流，pack 走 parse 抛错）。
 */

/** 词法单元：标识符 / 操作符 / 括号 / `+`。 */
type Token =
  | { kind: 'id'; value: string }
  | { kind: 'op'; value: 'AND' | 'OR' | 'WITH' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  /** `+` 后缀；adjacent=true 表示与前一 token 之间无空白（license-id"+" 硬要求）。 */
  | { kind: 'plus'; adjacent: boolean };

/** idstring = 1*(ALPHA / DIGIT / "-" / "." )。 */
const IDSTRING_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/** 标识符起止字符判定（tokenizer 逐字符收词用）。 */
function isIdChar(ch: string): boolean {
  return /[A-Za-z0-9.-]/.test(ch);
}

/**
 * 切词：空白分隔；`(` `)` `+` 为独立符号（可紧贴标识符，符合「`+` 前不得有空白」与
 * 「AND/OR 两侧必须有空白和/或括号」）。未知字符 → null（形状非法）。
 *
 * 空白只允许单空格 ASCII（0x20）：SPDX 表达式必须单行（tag:value 格式禁换行），
 * 因此制表符/换行视为非法字符而非空白——避免 `MIT\tOR\tX` 这类形态溜过。
 */
function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  /** 自上一个 token 结束以来是否出现过空白（`+` 邻接判定）。 */
  let sawSpace = true;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ') {
      sawSpace = true;
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      sawSpace = false;
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      sawSpace = false;
      i++;
      continue;
    }
    if (ch === '+') {
      // license-id"+" 硬要求：`+` 与前一 token 之间无空白
      tokens.push({ kind: 'plus', adjacent: !sawSpace });
      sawSpace = false;
      i++;
      continue;
    }
    if (isIdChar(ch)) {
      const start = i;
      while (i < input.length && (isIdChar(input[i]!) || input[i] === ':')) i++;
      const value = input.slice(start, i);
      if (value === 'AND' || value === 'OR' || value === 'WITH') {
        tokens.push({ kind: 'op', value });
        continue;
      }
      // license-ref = ["DocumentRef-"(idstring)":"]"LicenseRef-"(idstring)
      // idstring 非空硬要求：`LicenseRef-` / `DocumentRef-x:` 后余空即非法（形状错，不靠查表）
      if (value.includes(':')) {
        const ok = /^DocumentRef-[A-Za-z0-9][A-Za-z0-9.-]*:LicenseRef-[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value);
        if (!ok) return null;
      } else if (value.startsWith('LicenseRef-')) {
        if (!/^LicenseRef-[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value)) return null;
      } else if (!IDSTRING_RE.test(value)) {
        // idstring 必以 ALPHA/DIGIT 起（`-`/`.` 开头如 `-MIT`、`.x` 非法）
        return null;
      }
      tokens.push({ kind: 'id', value });
      sawSpace = false;
      continue;
    }
    // 非 SPDX 词法字符（含制表符、换行、逗号、斜杠、引号、非 ASCII）
    return null;
  }
  return tokens;
}

/** 语法分析器状态：token 序列 + 游标。 */
interface Parser {
  tokens: Token[];
  pos: number;
}

/**
 * compound-expression：
 *   simple-expression
 * | simple-expression "WITH" license-exception-id
 * | compound-expression "AND" compound-expression
 * | compound-expression "OR" compound-expression
 * | "(" compound-expression ")"
 *
 * `AND`/`OR` 左结合（ABNF 如此），但对形状校验不产生差异——只判能否归约成完整表达式。
 * `+` 只允许紧跟 simple-expression（license-id"+"），且必须在 `WITH` 之外（`GPL-2.0+ WITH ...` 非法）。
 */
function parseCompound(p: Parser): boolean {
  if (!parseSimple(p)) return false;
  // simple-expression "WITH" license-exception-id
  //   license-exception-id 是空 idstring 的标识符（形状层不查表）；`+` 后缀在此非法
  if (p.tokens[p.pos]?.kind === 'op' && (p.tokens[p.pos] as { value: string }).value === 'WITH') {
    p.pos++;
    const next = p.tokens[p.pos];
    if (next?.kind !== 'id') return false;
    p.pos++;
  }
  // compound AND/OR compound（左结合循环）
  while (p.tokens[p.pos]?.kind === 'op') {
    const op = (p.tokens[p.pos] as { value: 'AND' | 'OR' | 'WITH' }).value;
    if (op !== 'AND' && op !== 'OR') return false;
    p.pos++;
    if (!parseSimple(p)) return false;
    if (p.tokens[p.pos]?.kind === 'op' && (p.tokens[p.pos] as { value: string }).value === 'WITH') {
      p.pos++;
      const next = p.tokens[p.pos];
      if (next?.kind !== 'id') return false;
      p.pos++;
    }
  }
  return true;
}

/**
 * simple-expression = license-id ["+"] / license-ref / "(" compound-expression ")"。
 * `+` 为紧跟标识符的词法单元；tokenizer 记录它与前一 token 是否相邻——
 * `MIT +`（`+` 前有空白，而且 `+` 落在下一个 simple-expression 之前）在此拒绝。
 */
function parseSimple(p: Parser): boolean {
  const token = p.tokens[p.pos];
  if (token?.kind === 'lparen') {
    p.pos++;
    if (!parseCompound(p)) return false;
    if (p.tokens[p.pos]?.kind !== 'rparen') return false;
    p.pos++;
    return true;
  }
  if (token?.kind !== 'id') return false;
  p.pos++;
  // license-id"+"：`+` 必须无空白紧跟标识符（见 tokenize 的 adjacency 记录）
  const after = p.tokens[p.pos];
  if (after?.kind === 'plus') {
    if (after.adjacent !== true) return false;
    p.pos++;
  }
  return true;
}

/**
 * SPDX 表达式形状校验：合法 → true；非法 → false（永不抛错）。
 *
 * 语义边界：
 * - 合法：`MIT`、`Apache-2.0`、`AGPL-3.0-only`、`GPL-2.0+`、`MIT OR Apache-2.0`、
 *   `(MIT OR Apache-2.0) AND BSD-3-Clause`、`GPL-2.0-only WITH Classpath-exception-2.0`、
 *   `LicenseRef-Proprietary`、`DocumentRef-foo:LicenseRef-bar`、任意合法未知 idstring（`NotALicense`）
 * - 非法：空串/纯空白、悬空操作符（`MIT OR`）、`+` 前有空格（`MIT +`）、小写 `or`
 *   （操作符大小写敏感，`MIT or Apache-2.0` 的词序列不成立）、引号包裹（`"MIT"`）、
 *   `LicenseRef-`（空 idstring）、括号不配对、非 idstring 字符（`,` `/` 制表符 换行 非 ASCII）
 * - **不查表**：`mit`（小写标识符）形状合法即通过——标识符大小写不敏感，拼写裁决不在本层
 *
 * @param input 候选 SPDX 表达式（调用方应保证是 string；非 string 直接 false，不抛）
 */
export function isValidSpdxExpression(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  // 单行硬约束（SPDX tag:value 格式）：换行在 tokenize 里已被拒，这里再兜一句人话语义
  if (input.trim() !== input || input.length === 0) return false;
  const tokens = tokenize(input);
  if (tokens === null || tokens.length === 0) return false;
  const parser: Parser = { tokens, pos: 0 };
  if (!parseCompound(parser)) return false;
  return parser.pos === tokens.length;
}
