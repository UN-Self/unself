// SPDX-License-Identifier: AGPL-3.0-only
/** UChoiceCardGroup 类型（纯 ts）。 */
export interface ChoiceCardOption {
  value: string
  /** 主标题。 */
  title: string
  /** 次行说明（可省）。 */
  description?: string
  /** 禁用（如作者声明单项不接受选择——由调用方用说明卡而非禁用表达）。 */
  disabled?: boolean
}

export interface UChoiceCardGroupProps {
  /** 单选 = 'radio'；多选 = 'checkbox'。 */
  mode: 'radio' | 'checkbox'
  options: ChoiceCardOption[]
  /** 单选选中值；多选时忽略。 */
  modelValue?: string | null
  /** 多选选中集合；单选时忽略。 */
  modelValues?: string[]
  /** 表单内分组名称（radio 组内互斥依据）。 */
  name?: string
  /** 无障碍名称（分组 role=group 的 aria-label）。 */
  label: string
  disabled?: boolean
}

