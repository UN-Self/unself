// SPDX-License-Identifier: AGPL-3.0-only
// 公开面：只 re-export，供 app/installer 以库形式复用九步装配引擎（#242 薄壳方案）。
// 禁止在此文件写任何逻辑；装配逻辑一律在对应模块内。

export { runNineSteps } from './steps';
export type { Summary, StepReporter } from './steps';

// 模块卸载（#270）：平台按 tables 清单清理（撤路由 → 删 Worker → 删表 → 清记账 → 删注册表行）。
export { removeModule, assertDroppable } from './uninstall';
export type { RemoveModuleOptions, RemoveModuleResult } from './uninstall';

// 产物形态（#257）：安装器打包脚本与向导数据层消费；`artifactRootsFrom` 供嵌入式测试构造产物根。
// #284：产物里**不再有模块与 SDK**（两者都是普通 npm 包，由本地 node_modules 解析）。
export {
  ARTIFACTS_FORMAT_VERSION,
  artifactRootsFrom,
  defaultArtifactsPath,
  readArtifactsManifest,
  resolveArtifactRoots,
} from './artifacts';
export type { ArtifactRoots, ArtifactsManifest } from './artifacts';

// 装配产物构建原语（#257）：安装器构建期用它产出 dist/artifacts/**（core worker / SDK / 模块 worker bundle）。
export { coreWorkerEntrySource } from './steps';
export { DEPLOY_DIR } from './assemble';
export { copySdkAssets, bundleCoreWorker, bundleModuleWorker, moduleWorkerEntry, provisionAll, resolveSdkAssetsDir } from './assemble';

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
