// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `unself.config.jsonc` 的 `modules` 数组编辑（`unself module add`，issue #269）。
 *
 * 只动 `"modules": [ … ]` 这一段：定位 key → 括号配对（字符串/注释感知）→ 解析旧数组 →
 * 合并新条目 → 单行回写。**不是通用 JSONC 编辑器**：
 * - 只保留这一段以外的原文（注释零丢失）；
 * - 数组内部原有的注释/换行会被重排为单行（模板本就是单行），故若该段含无法解析的内容，
 *   直接抛人话错让用户手工编辑，绝不猜；
 * - 幂等：同一条目重复添加由调用方先行拦截。
 *
 * 零引擎依赖（CLI 核心命令不 import 装配引擎：#53 独立安装制品约束）。
 */

/** 待写入 config 的模块条目（#77：**不再有裸字符串/builtin**——官方模块也写 npm 串）。 */
export interface ModuleConfigEntry {
  id: string;
  /** 来源（npm:/github:/https:/file:）。 */
  source: string;
  /** 存储选择覆写（#55；向导③½/CLI 写入）。 */
  storage?: { declaration: string };
}

/** 段内注释剥离（JSONC → JSON；字符串感知，行注释与块注释）。 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      out += ch;
      i++;
      while (i < text.length) {
        out += text[i];
        if (text[i] === '\\') {
          out += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 定位 `"modules"` 键后数组的 `[` / `]` 下标（字符串/注释感知的括号配对）。 */
function locateModulesArray(text: string): { open: number; close: number } {
  const key = /"modules"\s*:/.exec(text);
  if (!key) throw new Error('unself.config.jsonc 里找不到 "modules" 段：请确认是 init 生成的配置文件');
  const start = key.index + key[0].length;
  const open = text.indexOf('[', start);
  if (open === -1) throw new Error('"modules" 段不是数组形态：请手工编辑该字段');
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') {
      depth--;
      if (depth === 0) return { open, close: i };
    }
    i++;
  }
  throw new Error('"modules" 数组括号不配对：请手工编辑该字段（不自动修改有语法错误的配置）');
}

/** config 里读出的模块条目（宽容形态：存量配置里可能还有裸字符串）。 */
type ReadModuleEntry = string | { id: string; source?: string };

/** 读 `"modules"` 段的原始数组（JSONC 宽容解析；不可解析 → 人话错，不猜）。 */
export function readModulesArray(text: string): ReadModuleEntry[] {
  const { open, close } = locateModulesArray(text);
  const inner = stripComments(text.slice(open, close + 1));
  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch (err) {
    throw new Error(
      `unself.config.jsonc 的 "modules" 段无法自动解析（${err instanceof Error ? err.message : String(err)}）：请手工编辑该字段（不自动改写有语法错误的配置）`,
    );
  }
  if (!Array.isArray(parsed)) throw new Error('"modules" 段不是数组形态：请手工编辑该字段');
  return parsed as ReadModuleEntry[];
}

/** 数组 → 单行 JSONC（对象条目单行展开，与模板风格一致）。 */
function serializeModulesArray(items: ReadonlyArray<ReadModuleEntry>): string {
  const parts = items.map((item) => JSON.stringify(item));
  return `[${parts.join(', ')}]`;
}

/**
 * 把一条模块条目加进 `"modules"` 段（返回新文本；重复 id 抛错）。
 * 其余原文（含注释）逐字节保留。
 */
export function addModuleToConfigText(text: string, entry: ModuleConfigEntry): string {
  const existing = readModulesArray(text);
  const hasId = existing.some((e) => (typeof e === 'string' ? e : e.id) === entry.id);
  if (hasId) {
    throw new Error(
      `模块 ${entry.id} 已在 unself.config.jsonc 的 modules 里：要换来源请手工编辑该条目，或用 --as <新名字> 换个实例内名字`,
    );
  }
  const next = [...existing, entry];
  const { open, close } = locateModulesArray(text);
  return text.slice(0, open) + serializeModulesArray(next) + text.slice(close + 1);
}

/**
 * 从 `"modules"` 段移除一个实例内 id（`unself module remove`，issue #270）：
 * 返回新文本与是否命中；未命中原样返回（调用方据 removed=false 报人话错，不静默）。
 * 其余原文（含注释）逐字节保留；数组内注释会重排为单行（与 add 同一条路）。
 */
export function removeModuleFromConfigText(text: string, id: string): { text: string; removed: boolean } {
  const existing = readModulesArray(text);
  const next = existing.filter((e) => (typeof e === 'string' ? e : e.id) !== id);
  if (next.length === existing.length) return { text, removed: false };
  const { open, close } = locateModulesArray(text);
  return { text: text.slice(0, open) + serializeModulesArray(next) + text.slice(close + 1), removed: true };
}
