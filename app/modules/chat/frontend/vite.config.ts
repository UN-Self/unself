// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * `public/dev-shim.html` 是**开发态宿主页**：它在浏览器里自造一个假 token 顶替壳，
 * 只为本地 `vite` 独立调试——**不该随模块包发布、也不该部署进实例**（已验证无法通过服务端验签，
 * 低危但没必要公开；且 npm 版本一旦发布无法收回）。dev server 仍照常提供它，
 * 仅构建产物里删掉副本。
 */
function excludeDevShimFromBuild(): Plugin {
  return {
    name: 'unself-exclude-dev-shim',
    closeBundle() {
      rmSync(join(HERE, '..', 'assets', 'frontend', 'dev-shim.html'), { force: true })
    },
  }
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), excludeDevShimFromBuild()],
  build: {
    // #284：产物直接落到模块包内（app/modules/chat/assets/frontend），随 `unself module pack` 入包发布
    outDir: '../assets/frontend',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test-setup.ts'],
  },
})
