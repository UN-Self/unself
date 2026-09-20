// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CF 资源 / Worker 名（#257 前缀，#272 命名空间）：同一份装配代码支持「同账户多实例」。
 *
 * 为什么需要：D1 / Worker / service binding / R2 桶名原先全是硬编码 `unself-*`——同一个 CF 账户上
 * 只能存在一个实例；第二个实例会静默复用第一个的 D1、覆盖其 Worker（#272）。
 *
 * 命名来源（优先级从高到低，**每次调用现算，不缓存**）：
 * 1. 环境变量 `UNSELF_RESOURCE_PREFIX`（显式覆盖；探针/CI 用；必须以 `-` 结尾）——存在即生效；
 * 2. 本次运行登记的**实例命名空间**（`setResourceNamespace`，由 `runNineSteps` 从 `config.namespace` 落）；
 * 3. 都没有 → 空前缀 = 既有历史形态 `unself-<base>`（老实例零影响）。
 *
 * 语义：
 * - 命名空间 `mysite`：`mysite-core` / `mysite-modules` / `mysite-workbench` / `mysite-module-hello` / `mysite-storage`；
 * - 无命名空间/空前缀：`unself-core` / `unself-workbench` / `unself-module-hello`；
 *   注意（#303）：**D1 / R2 名保持历史形态不动**（改了就是全新空库 = 丢数据），
 *   而 core Worker 名由历史 `unself-core-api` 改为 `unself-workbench`——这是**刻意的破坏性更新**：
 *   重跑部署会建新 Worker，旧 `unself-core-api` 需手工删掉（清场口径见 docs/deploy.md）。
 * - 前缀 `unself-probe-272-`：`unself-probe-272-core` / …（显式覆盖，探针隔离用）。
 *
 * 非法值直接抛错——名字写歪会造成「资源建一半、绑定指错 worker」的半套实例，宁停不住。
 */
/** 显式前缀环境变量（探针/CI 覆盖）。 */
export const RESOURCE_PREFIX_ENV = 'UNSELF_RESOURCE_PREFIX';
const PREFIX_RE = /^[a-z0-9][a-z0-9-]*-$/;
/** 命名空间形态：小写字母/数字/连字符，首尾必须是字母或数字，长度 ≤40（CF 资源名长度余量）。 */
export const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** 本次运行登记的实例命名空间（module-level；`runNineSteps` 进入时登记、退出时还原）。 */
let activeNamespace: string | undefined;

/**
 * 登记本次运行的实例命名空间（`config.namespace`；undefined/'' = 历史形态）。
 * 由 `runNineSteps` 调用；单元测试与嵌入式调用方可直接用。
 */
export function setResourceNamespace(namespace?: string): void {
  if (namespace === undefined || namespace === '') {
    activeNamespace = undefined;
    return;
  }
  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(
      `实例命名空间不合法："${namespace}"——需小写字母/数字开头结尾、只含小写字母/数字/连字符、长度 ≤40` +
        '（它会拼进 D1 / Worker / R2 / KV 名，写歪会拼出半个实例）',
    );
  }
  activeNamespace = namespace;
}

/** 当前登记的命名空间（未登记/历史形态 = undefined）。 */
export function activeResourceNamespace(): string | undefined {
  return activeNamespace;
}

/** 读并校验前缀：显式环境变量优先，其次当前命名空间，最后空前缀（历史形态）。 */
export function resourcePrefix(env: Record<string, string | undefined> = process.env): string {
  const raw = env[RESOURCE_PREFIX_ENV];
  if (raw !== undefined && raw !== '') {
    if (!PREFIX_RE.test(raw)) {
      throw new Error(
        `${RESOURCE_PREFIX_ENV} 不合法："${raw}"——需以小写字母/数字开头、以 "-" 结尾（形如 unself-probe-257-），` +
          '否则资源名会拼出半个实例（D1/Worker/service binding 三处必须同名同源）',
      );
    }
    return raw;
  }
  return activeNamespace ? `${activeNamespace}-` : '';
}

/**
 * 资源名：空前缀 → `unself-<base>`（历史形态）；有前缀 → `<prefix><base>`。
 * base 用「去掉 unself- 的部分」：core / modules / workbench / module-<id> / chat / chat-sessions / chat-files。
 */
export function resourceName(base: string, env: Record<string, string | undefined> = process.env): string {
  const prefix = resourcePrefix(env);
  return prefix ? `${prefix}${base}` : `unself-${base}`;
}

/** 纯函数：由显式命名空间拼资源名（不改 module-level 状态；向导/init 预览用）。 */
export function resourceNameFor(namespace: string | undefined, base: string): string {
  const ns = namespace?.trim();
  return ns ? `${ns}-${base}` : `unself-${base}`;
}

/** 便捷：core D1 名。 */
export function coreDbName(env?: Record<string, string | undefined>): string {
  return resourceName('core', env);
}
/** 便捷：modules D1 名。 */
export function modulesDbName(env?: Record<string, string | undefined>): string {
  return resourceName('modules', env);
}
/** 便捷：core Worker 名（同时是模块的 CORE_API service binding 目标；#303 起 base = workbench）。 */
export function coreWorkerName(env?: Record<string, string | undefined>): string {
  return resourceName('workbench', env);
}
/** 便捷：模块 Worker 名。 */
export function moduleWorkerName(moduleId: string, env?: Record<string, string | undefined>): string {
  return resourceName(`module-${moduleId}`, env);
}

/**
 * 探测式判断当前进程是否用了非空前缀（探针/多实例场景）：
 * 显式环境变量或登记的命名空间任一存在即 true。
 * 供日志与「五路残留复查」脚本对齐命名口径。
 */
export function isPrefixed(env?: Record<string, string | undefined>): boolean {
  return resourcePrefix(env) !== '';
}

/** 资源名预览项（向导/init 输出「本实例会占用哪些资源名」）。 */
export interface ResourceNamePreview {
  kind: string;
  name: string;
}

/**
 * 由命名空间 + 选中模块 + 桶名列出本实例会占用的 CF 资源名（纯函数）。
 * 只做预览/说明，不参与装配决策；派生规则与 `resourceName` 同源（命名空间 → `<ns>-<base>`）。
 */
export function previewResourceNames(input: {
  namespace?: string;
  moduleIds: string[];
  /** R2 桶名；缺省 = `<ns>-storage`（历史形态 `unself-storage`）。外部 S3 时传 undefined。 */
  bucket?: string;
}): ResourceNamePreview[] {
  const ns = input.namespace;
  const base = (name: string): string => resourceNameFor(ns, name);
  const out: ResourceNamePreview[] = [
    { kind: 'D1（core 库）', name: base('core') },
    { kind: 'D1（modules 库）', name: base('modules') },
    { kind: 'Worker（workbench）', name: base('workbench') },
  ];
  for (const id of input.moduleIds) {
    out.push({ kind: `Worker（模块 ${id}）`, name: base(`module-${id}`) });
  }
  if (input.bucket !== undefined) {
    out.push({ kind: 'R2 桶', name: input.bucket });
  }
  if (input.moduleIds.includes('chat')) {
    out.push({ kind: 'D1（chat 专属）', name: base('chat') });
    out.push({ kind: 'KV（chat 会话）', name: base('chat-sessions') });
    out.push({ kind: 'R2（chat 附件）', name: base('chat-files') });
  }
  return out;
}
