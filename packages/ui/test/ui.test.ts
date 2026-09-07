// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import * as ui from '../src/index'

describe('@unself/ui', () => {
  it('导出基元版本号', () => {
    expect(ui.UI_VERSION).toBe('0.1.0')
  })

  it('导出四个共享基元', () => {
    const names = ['UButton', 'UInput', 'UCard', 'UErrorCard'] as const
    for (const name of names) {
      expect(ui[name], `缺基元 ${name}`).toBeTruthy()
    }
  })
})
