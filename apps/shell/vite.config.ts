// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  test: {
    // #83：行为断言化后不再需要 css 级联（#75 getComputedStyle 类断言已退场）
  },
})
