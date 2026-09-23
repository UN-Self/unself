// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 服务端状态 DTO 的字段类型（只含 SPA 渲染所需的声明元数据，不含逻辑）。
 * 与 src/web/state.ts 的投影字段保持同形（字段漂移由 typecheck 拦）。
 */

export type StorageLevel = 'core' | 'shared' | 'dedicated' | 'external';

export interface WizardStorageOption {
  id: string
  accepts: StorageLevel[]
  preferred?: StorageLevel
}

export interface WizardConfigField {
  key: string
  label: string
  type: 'string' | 'secret' | 'number' | 'boolean' | 'enum' | 'url' | 'json' | 'oauth'
  required?: boolean
  default?: string
  options?: string[]
  test?: string
}

export interface WizardModuleConfig {
  id: string
  fields: WizardConfigField[]
}

export interface WizardResourceName {
  kind: string
  name: string
}
