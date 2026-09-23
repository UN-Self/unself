// SPDX-License-Identifier: AGPL-3.0-only
/** UActivity 类型（纯 ts）。 */
export interface ActivityLine {
  /** 事件唯一序号（调用方按它去重）。 */
  i: number
  text: string
}

export interface ActivityGroup {
  /** 步骤号（1-based）。 */
  step: number
  /** 步骤标题（如「步骤 3/9 模块」）。 */
  title: string
  state: 'running' | 'complete' | 'failed'
  lines: ActivityLine[]
}

