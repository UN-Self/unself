// SPDX-License-Identifier: AGPL-3.0-only
import type { Component } from 'vue'
export interface MenuAction {
  id: string
  label: string
  icon?: Component
  destructive?: boolean
}
