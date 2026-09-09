// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  test: {
    // #75：组件级布局回归需要 getComputedStyle 能级联到 SFC scoped CSS
    // （jsdom 不做布局，getBoundingClientRect 恒为 0，故以计算样式契约断言）。
    css: true,
  },
})
