// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { COMMON_EMOJI } from '../src/lib/emoji'

describe('Unicode emoji palette', () => {
  it('contains a stable non-empty set of Unicode characters', () => {
    expect(COMMON_EMOJI.length).toBeGreaterThan(20)
    expect(COMMON_EMOJI).toContain('😀')
    expect(COMMON_EMOJI).toContain('❤️')
  })
})
