// SPDX-License-Identifier: AGPL-3.0-only
/** UStepProgress 的段形状（纯 ts：供 tsc 侧 re-export，避免 .vue 具名导出被 shim 遮蔽）。 */
export interface StepSegment {
  n: number
  label: string
  state: 'done' | 'running' | 'failed' | ''
}
