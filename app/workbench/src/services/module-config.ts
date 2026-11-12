// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块配置值校验（#349 U8 ④）：manifest.config 声明的 schema → 用户存值逐 key 核。
 *
 * 服务端唯一真值面（AGENTS.md：权限/契约只信服务端）：工作台表单只是视图——
 * 直接打 API 也要过这里的 type 校验 / unknown key 拒 / required 拒 / oauth 拒。
 * admin PUT（工作台保存）与 module-api GET（模块读值）共用本文件，校验语义不第二处实现。
 *
 * 值的落库形态：string/enum/url/json 原文存字符串；number 存数字（PUT body JSON 数字
 * 或数字串均可）；boolean 存布尔；secret 存明文（#349 U8 定案：core 同域自托管场景，
 * 无跨域泄露面；读侧 admin GET 打码 '***'，PUT '***'/空串 = 保持不变）。
 */

/** secret 掩码（admin GET 回显用）；PUT 遇到此值 = 保持已存值不变。 */
export const CONFIG_SECRET_MASK = '***';

/** 字段声明的最小消费面（manifest 快照里的 config 元素；快照注册时已过契约 schema）。 */
export interface ConfigFieldInput {
  key: string;
  type: string;
  required?: boolean;
  options?: string[];
}

/** 校验失败：一条人话（400 detail 用）。 */
export class ConfigValidationError extends Error {}

/** value 是否「有值」（required 判定用：undefined/null/空串都算缺）。 */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** 单字段类型校验：通过返回落库值；不配抛 ConfigValidationError（人话）。 */
function checkField(field: ConfigFieldInput, value: unknown): unknown {
  switch (field.type) {
    case 'string':
    case 'secret':
      if (typeof value !== 'string') {
        throw new ConfigValidationError(`配置项 ${field.key} 需要字符串`);
      }
      return value;
    case 'url':
      if (typeof value !== 'string' || !/^https?:\/\//.test(value)) {
        throw new ConfigValidationError(`配置项 ${field.key} 需要 http(s) URL`);
      }
      return value;
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isFinite(n)) {
        throw new ConfigValidationError(`配置项 ${field.key} 需要数字`);
      }
      return n;
    }
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new ConfigValidationError(`配置项 ${field.key} 需要布尔值`);
      }
      return value;
    case 'enum':
      if (typeof value !== 'string' || !(field.options ?? []).includes(value)) {
        throw new ConfigValidationError(`配置项 ${field.key} 必须是 ${JSON.stringify(field.options ?? [])} 之一`);
      }
      return value;
    case 'json':
      // json：字符串形态给「可解析」检查（存原文本）；对象/数组形态序列化后存
      if (typeof value === 'string') {
        try {
          JSON.parse(value);
        } catch {
          throw new ConfigValidationError(`配置项 ${field.key} 不是合法 JSON 文本`);
        }
        return value;
      }
      if (typeof value === 'object' && value !== null) {
        return JSON.stringify(value);
      }
      throw new ConfigValidationError(`配置项 ${field.key} 需要 JSON 文本或对象`);
    case 'oauth':
      // oauth（决策 #53/#66）：连接授权在部署端完成，不收用户输入值
      throw new ConfigValidationError(`配置项 ${field.key}（oauth）需在部署端完成，不接受页面填值`);
  }
}

/**
 * 校验整份 values：返回落库形态 {key: 落库值}（含 secret 保持语义展开后的值）。
 * **合并语义**（与 registry 落点列同构）：从已存值出发（只留声明过的 key），再叠本提
 * 交——未提交的 key 保留旧值，整表单覆盖不会丢历史值；没有清空入口（清空归后续需要）。
 * - unknown key（manifest.config 里没有的）→ 拒；
 * - required：合并后仍无值 → 拒；
 * - secret 值 '***'（打码回显原样传回）或 ''（空串）→ 保持已存值（保持语义：回显打码
 *   但保留可覆写——传真值即覆盖，传掩码/空即不动）。
 */
export function validateModuleConfigValues(
  config: readonly ConfigFieldInput[],
  values: Record<string, unknown>,
  previous: Record<string, unknown> = {},
): Record<string, unknown> {
  const declared = new Map(config.map((f) => [f.key, f]));
  // 起点 = 已存值中仍被声明过的 key（声明已移除的残留值不续存）
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(previous)) {
    if (declared.has(key) && !isBlank(value)) out[key] = value;
  }
  for (const [key, value] of Object.entries(values)) {
    const field = declared.get(key);
    if (!field) {
      throw new ConfigValidationError(`未知配置项 ${key}（模块未声明该配置项）`);
    }
    // secret 保持语义：掩码/空串都算「保持」（起点已含旧值，直接跳过）；掩码值绝不落库
    if (field.type === 'secret' && (value === CONFIG_SECRET_MASK || value === '')) {
      continue;
    }
    if (isBlank(value)) {
      // 未交/空交：合并语义下保留旧值（required 由收口统一判）
      continue;
    }
    out[key] = checkField(field, value);
  }
  // required 收口：合并后仍无值 → 拒
  for (const field of config) {
    if (field.required && isBlank(out[field.key])) {
      throw new ConfigValidationError(`配置项 ${field.key} 为必填`);
    }
  }
  return out;
}
