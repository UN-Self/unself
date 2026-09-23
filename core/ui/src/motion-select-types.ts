// SPDX-License-Identifier: AGPL-3.0-only
/** UMotionSelect 类型（纯 ts）。 */
export interface SelectOption {
  value: string
  label: string
}

export interface UMotionSelectProps {
  /** 选中值（受控）。 */
  modelValue: string | null
  options: SelectOption[]
  /** 未选时触发器占位文案。 */
  placeholder?: string
  /** 无障碍名称（触发器/面板 aria-label）。 */
  label: string
  disabled?: boolean
}
