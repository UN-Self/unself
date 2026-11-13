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
 *   （以点路径记，如 storage.preferred / storage.accepts；#349 U5 后 accepts/preferred/declaration
 *   只有 core|self 两值）；
 * - flow 式 `key: [a, b]` **不支持**——直接报错而非静默丢（#64：静默丢会致权限漏授）。
 */

/** 解析产物：标量与 list 均可能带一层点路径（storage.*）；config 走独立的 objects 通道（#349 U8）。 */
export interface ParsedManifestYaml {
  scalars: Record<string, string>;
  lists: Record<string, string[]>;
  /**
   * config 块的 list-of-maps 项（按出现顺序；每项 = 首行 key + 缩进标量字段，值保留字符串形态，
   * required/default 的布尔/数字转换交契约 schema 处理）。未声明 config = 空数组。
   */
  configItems: Array<Record<string, string>>;
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
/**
 * config 块的 list-of-maps 项首行：`- key: value`（#349 U8）。
 * config 是「字段声明数组」，每项以 `- key: <名>` 开行，后续缩进标量归该项
 * （label/type/required/options…）；两层嵌套是本解析器唯二的嵌套形态之一（另一处 storage.*）。
 */
const CONFIG_ITEM_RE = /^(\s*)-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*(?:#.*)?$/;

/** manifest.yaml 文本 → 标量/清单（点路径）/config 块。解析失败（flow 式）直接抛错。 */
export function parseManifestYamlFields(text: string): ParsedManifestYaml {
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const configItems: Array<Record<string, string>> = [];
  /** 出现过的键路径（含空值键）——记录「声明过」这一事实，见 ParsedManifestYaml.declared。 */
  const declared: string[] = [];
  /** 最近一个顶层块键（嵌套标量与 list 归属锚点）。 */
  let topLevelKey: string | null = null;
  /** 最近一个键（顶层或嵌套，list 项归属用）。 */
  let currentKey: string | null = null;
  /** config 块的当前项（`- key: x` 开行后收集缩进标量；非 config 块为 null）。 */
  let configItem: Record<string, string> | null = null;
  /** config 项内最近一个空值键（项内嵌套 list 的归属锚点，如 options:）。 */
  let configListKey: string | null = null;
  /** 已收敛为实例地址、清单不再承载的键（#349 U9：地址只由 core 定，entry 声明直接拒）。 */
  const FORBIDDEN_YAML_KEYS = new Set(['entry']);
  for (const line of text.split('\n')) {
    // config list-of-maps 项首行（先于 SCALAR_RE 判——`- key: x` 也会被 LIST_ITEM_RE 吃掉）
    const configEntry = CONFIG_ITEM_RE.exec(line);
    if (configEntry && topLevelKey === 'config') {
      configItem = { [configEntry[2]!]: configEntry[3] ?? '' };
      configListKey = configEntry[3] === '' ? configEntry[2]! : null;
      configItems.push(configItem);
      continue;
    }
    const scalar = SCALAR_RE.exec(line);
    if (scalar) {
      const indent = scalar[1]!.length;
      const key = scalar[2]!;
      const value = scalar[3]!;
      // config 块内的缩进标量：归属当前 config 项（两层嵌套通道，不进 scalars 点路径）。
      // 空值键（如 options:）开启项内嵌套 list，后续 `- x` 行归它。
      if (indent > 0 && configItem && topLevelKey === 'config') {
        configItem[key] = value;
        configListKey = value === '' ? key : null;
        declared.push(`config.${configItem.key}.${key}`);
        continue;
      }
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
        if (indent === 0 && FORBIDDEN_YAML_KEYS.has(key)) {
          throw new Error(
            // 文案里不写 `#349`：verify-tokens 规则一把字符串字面量里的 issue 号当裸 hex（注释会被剥、字符串不会）。
            `manifest: 不再支持清单声明「${key}:」——地址只由 core 定（注册表 entry 列，issue 349 U9），从清单里删掉这行`,
          );
        }
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
      // config 项内的嵌套 list（如 options:）：归 configListKey 锚点，逗号串暂存（candidate 层拆数组）
      if (configItem && configListKey && topLevelKey === 'config') {
        configItem[configListKey] = configItem[configListKey]
          ? `${configItem[configListKey]},${item[1]}`
          : item[1]!;
        continue;
      }
      (lists[currentKey] ??= []).push(item[1]!);
    }
  }
  return { scalars, lists, configItems, declared };
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

/** 解析产物 → 契约候选对象（只映射 §3 冻结字段 + config，#349 U8）。 */
export function manifestYamlToCandidate(parsed: ParsedManifestYaml): ManifestCandidate {
  const { scalars, lists, configItems } = parsed;
  const storageAccepts = lists['storage.accepts'];
  const storagePreferred = scalars['storage.preferred'];
  const storageDeclaration = scalars['storage.declaration'];
  const license = resolveLicenseField(parsed);
  return {
    id: scalars.id,
    route: scalars.route,
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
    // config（#349 U8）：list-of-maps 按声明顺序带出。YAML 子集的值恒为字符串，
    // 字段名形已知（required=default=boolean、options=list）——在此按字段名形转换成
    // 契约 schema 的期待形态（严格校验仍归 schema：非 true/false 的 required 会被拒）。
    // 空 config 块（`config:` 无项）不带出——等同省略。
    ...(configItems.length > 0
      ? {
          config: configItems.map((item) => {
            const field: Record<string, unknown> = { ...item };
            if (field.required === 'true') field.required = true;
            else if (field.required === 'false') field.required = false;
            // 项内嵌套 list（options:）在解析层以逗号串暂存，这里拆回数组
            if (typeof field.options === 'string') field.options = field.options.split(',');
            return field;
          }),
        }
      : {}),
    ...(lists.compat ? { compat: { min: lists.compat[0], max: lists.compat[1] } } : {}),
  };
}
