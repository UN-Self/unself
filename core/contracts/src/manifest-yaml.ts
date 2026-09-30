// SPDX-License-Identifier: AGPL-3.0-only
/**
 * manifest.yaml 最小读取（模块作者书写格式 → 契约候选对象）。
 *
 * 放在 @unself/contracts（而非部署器私有）：官方模块装配、第三方 file: 安装、
 * validate 测试三处共用同一份解析，防实现漂移（#64 同原则：解析分叉会致授牌/校验错位）。
 *
 * 支持的 YAML 子集（docs/modules.md §3 字段表的书写形态）：
 * - 顶层标量 `key: value`（行尾 `# 注释` 剥除）；
 * - 顶层空值 key 开启块：缩进 list 项 `  - item`，或一层嵌套标量 `key: value`
 *   （以点路径记，如 storage.preferred / storage.accepts）；
 * - flow 式 `key: [a, b]` **不支持**——直接报错而非静默丢（#64：静默丢会致权限漏授）。
 */

/** 解析产物：标量与 list 均可能带一层点路径（storage.*）。 */
export interface ParsedManifestYaml {
  scalars: Record<string, string>;
  lists: Record<string, string[]>;
  /**
   * 出现过的键路径（含**空值键**，如 `license:`）——用于区分「字段显式声明但为空」
   * 与「完全省略」。目前只有 `license` 消费它（issue #292 退回），其余字段行为不变。
   */
  declared?: string[];
}

/** 契约候选对象：ModuleManifestSchema.parse 的直接输入（§3 字段名）。 */
export type ManifestCandidate = Record<string, unknown>;

const SCALAR_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*(?:#.*)?$/;
const LIST_ITEM_RE = /^\s*-\s+(.+?)\s*(?:#.*)?$/;

/** manifest.yaml 文本 → 标量/清单（点路径）。解析失败（flow 式）直接抛错。 */
export function parseManifestYamlFields(text: string): ParsedManifestYaml {
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  /** 出现过的键路径（含空值键）——记录「声明过」这一事实，见 ParsedManifestYaml.declared。 */
  const declared: string[] = [];
  /** 最近一个顶层块键（嵌套标量与 list 归属锚点）。 */
  let topLevelKey: string | null = null;
  /** 最近一个键（顶层或嵌套，list 项归属用）。 */
  let currentKey: string | null = null;
  for (const line of text.split('\n')) {
    const scalar = SCALAR_RE.exec(line);
    if (scalar) {
      const indent = scalar[1]!.length;
      const key = scalar[2]!;
      const value = scalar[3]!;
      // 嵌套标量恒归属最近顶层块（一层嵌套，如 storage.preferred），
      // 不受中间 list 项影响；更深嵌套不在 §3 字段表内，不做。
      const path = indent === 0 ? key : topLevelKey ? `${topLevelKey}.${key}` : key;
      declared.push(path);
      if (value.startsWith('[')) {
        throw new Error(
          `manifest: 不支持 flow 式 list「${path}: ${value}」——改用 block 式多行（docs/modules.md，#64）`,
        );
      }
      if (value !== '') {
        scalars[path] = value;
        currentKey = path;
      } else {
        // 空值 key 开启块：后续缩进 list 项 / 嵌套标量归属该 key
        currentKey = path;
      }
      if (indent === 0) topLevelKey = key;
      continue;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (item && currentKey) {
      (lists[currentKey] ??= []).push(item[1]!);
    }
  }
  return { scalars, lists, declared };
}

/**
 * `license` 声明的形状还原（issue #292 退回）。
 *
 * 契约口径：**只有完全省略 `license` 键**才允许 `pack` 回落平台默认；只要声明过，
 * 无论形态（空值 / list / 嵌套对象）都必须把「声明存在」带出去交 `ModuleManifestSchema`
 * 判非法——不能静默丢弃后回落 AGPL（那是把有法律含义的错误信息写进 npm 元数据）。
 * 与 JSON 入口一致：`"license": ""` / `[...]` / `{...}` / `null` 在 JSON 路径同样被 schema 拒。
 *
 * 只针对 `license` 一个键，不扩到通用 YAML 重写（其他空值键行为不变）。
 */
function resolveLicenseField(parsed: ParsedManifestYaml): { present: boolean; value: unknown } {
  const { scalars, lists } = parsed;
  if (scalars.license !== undefined) return { present: true, value: scalars.license };
  if (lists.license !== undefined) return { present: true, value: lists.license };
  const nestedKeys = Object.keys(scalars).filter((key) => key.startsWith('license.'));
  if (nestedKeys.length > 0) {
    const nested: Record<string, string> = {};
    for (const key of nestedKeys) nested[key.slice('license.'.length)] = scalars[key]!;
    return { present: true, value: nested };
  }
  // `license:` 空值：存在但无值 → 以空串带出（schema 形状校验必拒），不是「省略」
  if ((parsed.declared ?? []).includes('license')) return { present: true, value: '' };
  return { present: false, value: undefined };
}

/** 解析产物 → 契约候选对象（只映射 §3 冻结字段；config 等待定形态此处不解析）。 */
export function manifestYamlToCandidate(parsed: ParsedManifestYaml): ManifestCandidate {
  const { scalars, lists } = parsed;
  const storageAccepts = lists['storage.accepts'];
  const storagePreferred = scalars['storage.preferred'];
  const storageDeclaration = scalars['storage.declaration'];
  const license = resolveLicenseField(parsed);
  return {
    id: scalars.id,
    route: scalars.route,
    entry: scalars.entry,
    version: scalars.version,
    runtimes: lists.runtimes ?? [],
    ...(scalars.description ? { description: scalars.description } : {}),
    ...(scalars.icon ? { icon: scalars.icon } : {}),
    // 许可证（issue #292）：声明过就必须带出（含空值/list/嵌套对象），交 schema 判非法；
    // 只有完全省略才 omit —— 省略时 pack 才回落平台默认
    ...(license.present ? { license: license.value } : {}),
    ...(lists.permissions ? { permissions: lists.permissions } : {}),
    ...(storageAccepts || storagePreferred || storageDeclaration
      ? {
          storage: {
            accepts: storageAccepts ?? [],
            ...(storagePreferred ? { preferred: storagePreferred } : {}),
            ...(storageDeclaration ? { declaration: storageDeclaration } : {}),
          },
        }
      : {}),
    ...(lists.tables ? { tables: lists.tables } : {}),
    ...(lists.tablesShared ? { tablesShared: lists.tablesShared } : {}),
    ...(lists.compat ? { compat: { min: lists.compat[0], max: lists.compat[1] } } : {}),
  };
}
