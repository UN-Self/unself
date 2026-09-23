// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `@unself/sdk` 的**契约对外可见面**（决策 #78② / issue #294）。
 *
 * 契约包（`core/contracts`）保持内部；模块作者只装 `@unself/sdk`。本文件把
 * 决策 #78② 点名的四项对外可见部分具名导出：
 *
 * - `ModuleManifestSchema`（+ 其解析入口 `manifestFromYamlText`）——提交前自校验 manifest；
 * - `CONTRACT_VERSION`——判断自己的模块要求哪个契约版本；
 * - `MODULE_PERMISSIONS`（权限词表）与 `isKnownPermission`——查「词表里有没有这个能力」；
 * - 类型镜像 `ModuleManifest` / `ModulePermission`。
 *
 * **真源仍是契约包**：值在构建期由 esbuild 内联（A1/A4），公开签名只引用本文件声明的
 * 结构类型，故发布产物（JS + `.d.ts`）不引用 `@unself/contracts`（构建期自检
 * `scripts/build.mjs` 的发布面不变量兜住）。镜像与契约的等价性由
 * `test/contract-parity.test.ts` 在 `pnpm -r typecheck` 下双向校对。
 *
 * 契约版本：本改动是**增量新增导出**，不需要 bump（决策 #57）。
 */
import {
  CONTRACT_VERSION as contractContractVersion,
  MODULE_PERMISSIONS as contractModulePermissions,
  ModuleManifestSchema as contractModuleManifestSchema,
  manifestFromYamlText as contractManifestFromYamlText,
} from '@unself/contracts';

import type { ModuleManifest, ModulePermission } from './contract-types.js';

// ---- 类型镜像（公开签名自包含；等价性由 contract-parity.test.ts 守卫）----

export type { ModuleManifest, ModulePermission };

/**
 * 单条校验问题（结构镜像 zod 的 `ZodIssue` 最小面）：
 * 模块作者据此知道**哪个字段**错了、为什么错。
 */
export interface ManifestIssue {
  /** 出错字段路径（顶层字段名起；根对象问题为空数组）。 */
  path: readonly PropertyKey[];
  /** 人话错误消息。 */
  message: string;
}

/** `safeParse` 成功分支。 */
export interface ManifestParseSuccess {
  success: true;
  data: ModuleManifest;
}

/** `safeParse` 失败分支（`issues` 非空）。 */
export interface ManifestParseFailure {
  success: false;
  error: { issues: readonly ManifestIssue[] };
}

/** `ModuleManifestSchema` 的公开方法面（不泄漏 zod 类型，保持 d.ts 自包含）。 */
export interface ManifestSchema {
  /** 校验通过返回 manifest；失败抛错（zod 语义）。 */
  parse(input: unknown): ModuleManifest;
  /** 校验并返回结果对象，**不抛**（模块作者自校验首选入口）。 */
  safeParse(input: unknown): ManifestParseSuccess | ManifestParseFailure;
  /** YAML 文本（manifest.yaml）→ 契约候选对象，可直接喂 `parse`/`safeParse`。 */
  // 注：解析入口单独具名导出（见下），此处不挂到 schema 对象上以免改变契约对象形状。
}

// ---- 值再导出（构建期内联，见 build.mjs 的 external/自检）----

/**
 * 契约版本（决策 #57）：独立于产品版本，只在破坏性变更时 bump。
 * 模块在 `manifest.compat` 里声明自己要求的区间；省略 = 接受任意版本。
 */
export const CONTRACT_VERSION: string = contractContractVersion;

/**
 * permissions 能力词表（决策 #56）：门禁——模块向平台请求的权限。
 * 词表归 core 定义并随契约版本走，模块不得自定义；未知能力在安装时直接拒绝。
 * `readonly` 是编译期约束（运行时用 `isKnownPermission` 判定）。
 */
export const MODULE_PERMISSIONS: readonly string[] = contractModulePermissions;

/**
 * 判定能力名是否在词表内（issue #294 验收项）。
 *
 * 与安装器门禁**同源**：两者都从同一个 `MODULE_PERMISSIONS` 常量派生（安装器
 * `assertKnownPermissions` 也做 `MODULE_PERMISSIONS.includes`）；一致性由安装器侧
 * 「逐值比对」测试守住。大小写敏感——`'Storage'` 是未知能力（与安装器口径一致）。
 *
 * 注意：本判定只回答「词表里有没有」，**不构成授权**——权限真值取服务端注册表快照（#56）。
 */
export function isKnownPermission(permission: unknown): boolean {
  return typeof permission === 'string' && (MODULE_PERMISSIONS as readonly string[]).includes(permission);
}

/**
 * 模块清单（manifest）契约校验器（§3 字段冻结表）。
 * 硬护栏（schema 层直接拒绝）：storage.accepts 含 shared 必须申报 tables；preferred/declaration
 * 必须是 accepts 成员；coreOrigin 禁止 `'*'`；entry 非 https 仅 localhost 豁免。
 *
 * 结构性赋值（不是 `as` 断言）保证契约对象形状确实满足本公开方法面。
 */
export const ModuleManifestSchema: ManifestSchema = contractModuleManifestSchema;

/**
 * manifest.yaml 文本 → 契约候选对象（§3 字段名，`ModuleManifestSchema.parse` 直接入参）。
 * 与安装器、官方模块装配共用**同一份**解析（#64：解析分叉会致授牌/校验错位）。
 */
export const manifestFromYamlText: (manifestText: string) => unknown = contractManifestFromYamlText;
