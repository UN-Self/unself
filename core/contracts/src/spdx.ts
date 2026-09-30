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
 * **规范依据（唯一判据）**：SPDX Specification **v2.3**（2022-11）Annex D
 * 「SPDX License Expressions」<https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/>。
 * 第三方实现（如 `spdx-expression-parse`）不作为规范判据，也不因其宽松而放宽本层。
 *
 * ABNF（原文，逐条落地，不做增删）：
 *   idstring            = 1*(ALPHA / DIGIT / "-" / "." )      ← 无「首字符必须字母数字」限制
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
 * 间距规则（原文，逐条落地）：
 *   - `+` 与 license-id 之间**不得**有空白；
 *   - 操作符 `WITH` 两侧**必须**有空白；
 *   - 操作符 `AND` / `OR` 两侧必须有**空白和/或括号**。
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
 * **保留前缀的处置（形状，非查表）**：`license-ref` 是 ABNF 里与 `license-id` 并列的
 * 独立产生式，其可识别形状为 `LicenseRef-…` / `DocumentRef-…:LicenseRef-…`。因此：
 * - `+` 只挂 license-id（license-ref 不带 `+`）；
 * - `license-exception-id` 不取保留的 ref 前缀（`LicenseRef-x` 依 ABNF 只构成 license-ref）。
 * 这与「查 SPDX 标识表」无关——前缀是词法形状，不是列表查询。
 *
 * **与本层确实能拒的相邻形态的区别**：`MIT and Apache-2.0` / `MIT or Apache-2.0` 是
 * **由空白分开的三个 idstring**（小写 `and`/`or` 不是操作符），词序列不构成表达式 → 拒。
 *
 * 解析实现：**显式栈迭代**（非递归下降）——括号深度任意大也不爆栈，兑现「永不抛错」契约
 * （`unself module validate` 走诊断流，`pack` 走 parse 抛错；本函数只返回 true/false）。
 *
 * 实测证据（退回项前后原始输出）见 PR #326 与 issue #292 评论。
 */

/** 词法单元：标识符 / 操作符 / 括号 / `+`；均带 `spaceBefore`（前方是否有 ASCII 空格）。 */
type Token =
  | { kind: 'id'; value: string; spaceBefore: boolean }
  | { kind: 'op'; value: 'AND' | 'OR' | 'WITH'; spaceBefore: boolean }
  | { kind: 'lparen'; spaceBefore: boolean }
  | { kind: 'rparen'; spaceBefore: boolean }
  | { kind: 'plus'; spaceBefore: boolean };

/** idstring = 1*(ALPHA / DIGIT / "-" / "." )——注意 1* 不限定首字符。 */
const IDSTRING_RE = /^[A-Za-z0-9.-]+$/;

/** license-ref = ["DocumentRef-"(idstring)":"]"LicenseRef-"(idstring)（idstring 非空）。 */
const LICENSE_REF_RE = /^LicenseRef-[A-Za-z0-9.-]+$/;
const DOCUMENT_REF_RE = /^DocumentRef-[A-Za-z0-9.-]+:LicenseRef-[A-Za-z0-9.-]+$/;

/**
 * token 是否是可识别的 license-ref 形状（`LicenseRef-…` / `DocumentRef-…:LicenseRef-…`）。
 * 前缀是**形状**特征（见 tokenize 的 ref 校验），不是 SPDX License List 查询。两条判定依赖它：
 * - `+` 只挂 license-id（ABNF: simple-expression = license-id / license-id"+" / license-ref）；
 * - license-exception-id 不取保留的 ref 前缀（`LicenseRef-` 依 ABNF 只构成 license-ref）。
 */
function isLicenseRefValue(value: string): boolean {
  return value.startsWith('LicenseRef-') || value.includes(':');
}

/** idstring 字符集判定（tokenizer 逐字符收词用）：ALPHA / DIGIT / "-" / "."。 */
function isIdChar(ch: string): boolean {
  return /[A-Za-z0-9.-]/.test(ch);
}

/**
 * 切词：空白分隔；`(` `)` `+` 为独立符号（可紧贴标识符，符合「`+` 前不得有空白」与
 * 「AND/OR 两侧必须有空白和/或括号」）。未知字符 → null（形状非法）。
 *
 * 每个 token 记 `spaceBefore`：供上层判定 WITH 两侧空白、AND/OR 两侧空白和/或括号。
 * 空白只允许单空格 ASCII（0x20）：SPDX 表达式必须单行（tag:value 格式禁换行），
 * 因此制表符/换行视为非法字符而非空白——避免 `MIT\tOR\tX` 这类形态溜过。
 */
function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  /** 自上一个 token 结束以来是否出现过空格；输入起始视作 true。 */
  let sawSpace = true;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ') {
      sawSpace = true;
      i++;
      continue;
    }
    const spaceBefore = sawSpace;
    sawSpace = false;
    if (ch === '(') {
      tokens.push({ kind: 'lparen', spaceBefore });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', spaceBefore });
      i++;
      continue;
    }
    if (ch === '+') {
      tokens.push({ kind: 'plus', spaceBefore });
      i++;
      continue;
    }
    if (isIdChar(ch)) {
      const start = i;
      while (i < input.length && (isIdChar(input[i]!) || input[i] === ':')) i++;
      const value = input.slice(start, i);
      if (value === 'AND' || value === 'OR' || value === 'WITH') {
        tokens.push({ kind: 'op', value, spaceBefore });
        continue;
      }
      // license-ref = ["DocumentRef-"(idstring)":"]"LicenseRef-"(idstring)
      // idstring 非空硬要求：`LicenseRef-` / `DocumentRef-x:` 后余空即非法（形状错，不靠查表）
      if (value.includes(':')) {
        if (!DOCUMENT_REF_RE.test(value)) return null;
      } else if (value.startsWith('LicenseRef-')) {
        if (!LICENSE_REF_RE.test(value)) return null;
      } else if (!IDSTRING_RE.test(value)) {
        return null;
      }
      tokens.push({ kind: 'id', value, spaceBefore });
      continue;
    }
    // 非 SPDX 词法字符（含制表符、换行、逗号、斜杠、引号、非 ASCII）
    return null;
  }
  return tokens;
}

/**
 * 语法分析（**显式栈迭代**，无递归——任意括号深度都不抛错）。
 *
 * 状态：`prev` 为上一个操作数形态，`null` 表示「正期待一个操作数」：
 * - `simple`  = license-id / license-id"+" / license-ref（可作 WITH 左操作数）
 * - `paren`   = "(" compound-expression ")"（不可作 WITH 左操作数）
 * - `exception` = simple-expression "WITH" license-exception-id
 * `depth` = 未闭合左括号数（显式栈的计数器）。
 *
 * 逐条对应 compound-expression 产生式；越界即 false。
 */
function parseTokens(tokens: Token[]): boolean {
  let depth = 0;
  let prev: 'simple' | 'paren' | 'exception' | null = null;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    // —— 期待操作数（表达式起点 / AND|OR 之后）——
    if (prev === null) {
      if (t.kind === 'lparen') {
        depth++;
        i++;
        continue;
      }
      if (t.kind === 'id') {
        // license-id"+"：`+` 须无空白紧邻前一 token，且前一 token 须是 license-id（非 ref）
        const plus = tokens[i + 1];
        if (plus?.kind === 'plus') {
          if (plus.spaceBefore !== false || isLicenseRefValue(t.value)) return false;
          i += 2;
        } else {
          i += 1;
        }
        prev = 'simple';
        continue;
      }
      return false; // op / rparen / plus 出现在操作数位
    }
    // —— 期待操作符 / 右括号 / 结束 ——
    if (t.kind === 'rparen') {
      if (depth === 0) return false;
      depth--;
      prev = 'paren'; // 括号复合式整体是一个操作数
      i++;
      continue;
    }
    if (t.kind === 'op') {
      if (t.value === 'WITH') {
        // WITH 两侧必须有空白；左操作数必须是 simple-expression（括号复合式不行）
        if (t.spaceBefore !== true) return false;
        if (prev !== 'simple') return false;
        const exception = tokens[i + 1];
        if (
          exception?.kind !== 'id' ||
          exception.spaceBefore !== true ||
          isLicenseRefValue(exception.value)
        ) {
          return false;
        }
        prev = 'exception';
        i += 2;
        continue;
      }
      // AND / OR：两侧必须有空白和/或括号
      const leftOk = t.spaceBefore === true || tokens[i - 1]?.kind === 'rparen';
      if (!leftOk) return false;
      const right = tokens[i + 1];
      if (right === undefined) return false; // 悬空操作符
      const rightOk = right.kind === 'lparen' || right.spaceBefore === true;
      if (!rightOk) return false;
      prev = null;
      i++;
      continue;
    }
    return false; // lparen / plus 出现在操作符位
  }
  return prev !== null && depth === 0;
}

/**
 * SPDX 表达式形状校验：合法 → true；非法 → false（**永不抛错**，含任意深嵌套）。
 *
 * 语义边界：
 * - 合法：`MIT`、`Apache-2.0`、`AGPL-3.0-only`、`GPL-2.0+`、`MIT OR Apache-2.0`、
 *   `(MIT OR Apache-2.0) AND BSD-3-Clause`、`GPL-2.0-only WITH Classpath-exception-2.0`、
 *   `LicenseRef-Proprietary`、`LicenseRef-.custom`、`DocumentRef--doc:LicenseRef-custom`、
 *   任意合法未知 idstring（`NotALicense`）
 * - 非法：空串/纯空白、悬空操作符（`MIT OR`）、`+` 前有空格（`MIT +`）、小写 `or`
 *   （操作符大小写敏感，`MIT or Apache-2.0` 的词序列不成立）、引号包裹（`"MIT"`）、
 *   `LicenseRef-`（空 idstring）、`+` 挂 license-ref（`LicenseRef-x+`）、
 *   WITH 两侧无空白（`GPL-2.0+WITH X`）、AND/OR 两侧既无空白也无括号（`MIT+OR X`）、
 *   括号复合式作 `WITH` 左操作数（`(MIT OR X) WITH Y`）、保留 ref 前缀作例外标识（`MIT WITH LicenseRef-x`）、
 *   括号不配对、非 idstring 字符（`,` `/` 制表符 换行 非 ASCII）
 * - **不查表**：`mit`（小写标识符）形状合法即通过——标识符大小写不敏感，拼写裁决不在本层
 *
 * @param input 候选 SPDX 表达式（非 string 直接 false，不抛）
 */
export function isValidSpdxExpression(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  // 单行硬约束（SPDX tag:value 格式）：换行在 tokenize 里已被拒，这里再兜一句人话语义
  if (input.trim() !== input || input.length === 0) return false;
  const tokens = tokenize(input);
  if (tokens === null || tokens.length === 0) return false;
  return parseTokens(tokens);
}
