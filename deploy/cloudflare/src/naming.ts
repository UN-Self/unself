// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CF 资源 / Worker 名（#257）：同一份装配代码支持「同账户多实例」，靠一个可选**名前缀**。
 *
 * 为什么需要：D1 / Worker / service binding 名原先全是硬编码 `unself-*`——同一个 CF 账户上
 * 只能存在一个实例，隔离探针（`unself-probe-<n>-*`）也没法做。前缀让「另起一套资源」成为可能。
 *
 * 语义（默认空前缀 = 与既有生产名逐字一致，零行为变化）：
 * - 空前缀：`unself-core` / `unself-core-api` / `unself-module-hello`（现状）；
 * - 前缀 `unself-probe-257-`：`unself-probe-257-core` / `unself-probe-257-core-api` / …。
 *
 * 来源：环境变量 `UNSELF_RESOURCE_PREFIX`（必须以 `-` 结尾，`^[a-z0-9][a-z0-9-]*-$`）。
 * 非法值直接抛错——名字写歪会造成「资源建一半、绑定指错 worker」的半套实例，宁停不住。
 * 每次调用现读 process.env（测试可 set/unset；不缓存）。
 */
/** 无效前缀的人话报错（含形状示例）。 */
export const RESOURCE_PREFIX_ENV = 'UNSELF_RESOURCE_PREFIX';
const PREFIX_RE = /^[a-z0-9][a-z0-9-]*-$/;

/** 读并校验前缀（缺省/空串 = 空前缀 = 现状命名）。 */
export function resourcePrefix(env: Record<string, string | undefined> = process.env): string {
  const raw = env[RESOURCE_PREFIX_ENV];
  if (raw === undefined || raw === '') return '';
  if (!PREFIX_RE.test(raw)) {
    throw new Error(
      `${RESOURCE_PREFIX_ENV} 不合法："${raw}"——需以小写字母/数字开头、以 "-" 结尾（形如 unself-probe-257-），` +
        '否则资源名会拼出半个实例（D1/Worker/service binding 三处必须同名同源）',
    );
  }
  return raw;
}

/**
 * 资源名：空前缀 → `unself-<base>`（现状）；有前缀 → `<prefix><base>`。
 * base 用「去掉 unself- 的部分」：core / modules / core-api / module-<id> / chat / chat-sessions / chat-files。
 */
export function resourceName(base: string, env: Record<string, string | undefined> = process.env): string {
  const prefix = resourcePrefix(env);
  return prefix ? `${prefix}${base}` : `unself-${base}`;
}

/** 便捷：core D1 名。 */
export function coreDbName(env?: Record<string, string | undefined>): string {
  return resourceName('core', env);
}
/** 便捷：modules D1 名。 */
export function modulesDbName(env?: Record<string, string | undefined>): string {
  return resourceName('modules', env);
}
/** 便捷：core Worker 名（同时是模块的 CORE_API service binding 目标）。 */
export function coreWorkerName(env?: Record<string, string | undefined>): string {
  return resourceName('core-api', env);
}
/** 便捷：模块 Worker 名。 */
export function moduleWorkerName(moduleId: string, env?: Record<string, string | undefined>): string {
  return resourceName(`module-${moduleId}`, env);
}

/**
 * 探测式判断当前进程是否用了非空前缀（探针/多实例场景）。
 * 供日志与「五路残留复查」脚本对齐命名口径，不参与装配决策。
 */
export function isPrefixed(env?: Record<string, string | undefined>): boolean {
  return resourcePrefix(env) !== '';
}
