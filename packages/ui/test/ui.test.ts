// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { UI_VERSION } from '../src/index'

describe('@unself/ui', () => {
  it('导出 UI_VERSION 且值为 0.0.0', () => {
    expect(UI_VERSION).toBe('0.0.0')
  })
})
