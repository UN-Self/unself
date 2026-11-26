// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config'

/** 后端测试只收 test/，避免把前端用例重复跑一遍。 */
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
})
