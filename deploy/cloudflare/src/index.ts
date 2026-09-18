// SPDX-License-Identifier: AGPL-3.0-only
// 公开面：只 re-export，供 packages/installer 以库形式复用九步装配引擎（#242 薄壳方案）。
// 禁止在此文件写任何逻辑；装配逻辑一律在对应模块内。

export { runNineSteps } from './steps';
export type { Summary, StepReporter } from './steps';

// 产物形态（#257）：安装器打包脚本与向导数据层消费；`artifactRootsFrom` 供嵌入式测试构造产物根。
export {
  ARTIFACTS_FORMAT_VERSION,
  artifactRootsFrom,
  builtinModuleDir,
  defaultArtifactsPath,
  readArtifactsManifest,
  resolveArtifactRoots,
} from './artifacts';
export type { ArtifactRoots, ArtifactsManifest } from './artifacts';

// 装配产物构建原语（#257）：安装器构建期用它产出 dist/artifacts/**（core worker / SDK / 模块 worker bundle）。
export { coreWorkerEntrySource } from './steps';
export { buildModuleSdkAssets, bundleCoreWorker, bundleModuleWorker, moduleWorkerEntry, provisionAll } from './assemble';

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

export { createCoreControlPlane } from './control-plane';
export { progressTracker } from './progress';
export { advise, formatAdvice } from './errors';

export * from './rest/index';
