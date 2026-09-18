// SPDX-License-Identifier: AGPL-3.0-only
// 公开面：只 re-export，供 packages/installer 以库形式复用九步装配引擎（#242 薄壳方案）。
// 禁止在此文件写任何逻辑；装配逻辑一律在对应模块内。

export { runNineSteps } from './steps';
export type { Summary, StepReporter } from './steps';

export { loadUnselfConfig, parseUnselfConfigText, UnselfConfigSchema } from './config';
export type { UnselfConfig } from './config';

export { createCoreControlPlane } from './control-plane';
export { progressTracker } from './progress';
export { advise, formatAdvice } from './errors';

export * from './rest/index';
