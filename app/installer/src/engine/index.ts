// SPDX-License-Identifier: AGPL-3.0-only
// 公开面：只 re-export，供 app/installer 以库形式复用九步装配引擎（#242 薄壳方案）。
// 禁止在此文件写任何逻辑；装配逻辑一律在对应模块内。

export { runNineSteps } from './steps';
export type { Summary, StepReporter } from './steps';

// 模块卸载（#270）：平台按 tables 清单清理（撤路由 → 删 Worker → 删表 → 清记账 → 删注册表行）。
export { removeModule, assertDroppable } from './uninstall';
export type { RemoveModuleOptions, RemoveModuleResult } from './uninstall';

// 平台产物（#303 修订 #257 口径）：产物随 @unself/workbench 包发布，引擎只解析与消费。
// `platformArtifactsFrom` 供嵌入式测试构造产物根；模块与 SDK 是普通 npm 包（node_modules 解析）。
export { platformArtifactsFrom, resolvePlatformArtifacts, WORKBENCH_PACKAGE } from './artifacts';
export type { PlatformArtifacts } from './artifacts';

// 装配原语：模块 worker bundle 仍在引擎内（模块是第三方，结构由契约定）；core/壳产物由 workbench 自建。
export { DEPLOY_DIR } from './assemble';
export { copySdkAssets, bundleModuleWorker, moduleWorkerEntry, provisionAll, resolveSdkAssetsDir } from './assemble';

// 资源命名（#257/#272）：UNSELF_RESOURCE_PREFIX 显式覆盖 + 实例命名空间 + 资源名预览。
export {
  activeResourceNamespace,
  coreDbName,
  coreWorkerName,
  isPrefixed,
  moduleWorkerName,
  modulesDbName,
  NAMESPACE_RE,
  previewResourceNames,
  resourceName,
  resourceNameFor,
  resourcePrefix,
  setResourceNamespace,
} from './naming';
export type { ResourceNamePreview } from './naming';

// 撞车守卫（#272）：账户同名资源归属判定（unself.lock 资源台账）。
export {
  decideGuard,
  formatCollisionMessage,
  ledgerCovers,
  probeExisting,
  ResourceCollisionError,
  targetResources,
} from './guard';
export type { ExistingResource, GuardOutcome, ResourceKind, TargetResource } from './guard';

export { loadUnselfConfig, parseUnselfConfigText, withNamespacedBucket } from './config';
export type { UnselfConfig } from './config';

// 模块来源入口与打包（#269）：来源预览 / 打包器 / unself.lock 记账原语（安装器 module add 复用）。
export { previewModuleSource } from './module-preview';
export type { ModulePreview, PreviewInput, PreviewStorageLevel } from './module-preview';
export { localModuleManifest } from './module-sources';
export { modulePackageFiles, packModuleDir } from './module-pack';
export type { ModulePackageFile, ModulePackageInput } from './module-pack';
export { emptyLock, LOCK_FILENAME, manifestHashOf, parseLockText, serializeLock, buildLockPlan } from './lock';
export type { LockFile, LockPlan } from './lock';
export { parseSource, sriFromBuffer, satisfiesVersionRange, findLocalPackageDir, localPackageDir, resolveLocalNpmPackage } from './sources';
export type { ParsedSource, LocalNpmPackage } from './sources';
export { normalizeModuleEntries } from './config';
export type { NormalizedModuleEntry } from './config';

export { createCoreControlPlane } from './control-plane';
export { progressTracker } from './progress';
export { advise, formatAdvice } from './errors';

export * from './rest/index';
