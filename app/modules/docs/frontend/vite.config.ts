// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vitest/config" />
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * docs 模块前端。dev（`vite`）跑组件层；build 产出模块页面，交给包内 assets/ 由 node 入口服务。
 *
 * base 用相对路径：契约规定模块永远按「挂在根路径」写代码，`/m/<id>/` 前缀由宿主剥掉
 * （docs/modules.md §8），写死前缀会在壳里取不到资源。
 */
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: '../assets',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
  },
})
