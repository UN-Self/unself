// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vitest/config" />
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * D9 编辑器前端（组件层）。入口（index.html/main.ts/App.vue/路由）归 D7 的壳，
 * 本包当前只暴露组件 + lib + 测试面；dev/build 脚本待 D7 接线后补。
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    globals: false,
  },
})
