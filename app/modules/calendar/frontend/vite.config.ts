// SPDX-License-Identifier: AGPL-3.0-only
import vue from '@vitejs/plugin-vue'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const HERE = dirname(fileURLToPath(import.meta.url))

/** dev-shim 只在开发态用，构建产物里删掉（照 chat：假 token 页不该发布）。 */
function excludeDevShimFromBuild(): Plugin {
  return {
    name: 'unself-exclude-dev-shim',
    closeBundle() {
      rmSync(join(HERE, '..', 'assets', 'frontend', 'dev-shim.html'), { force: true })
    },
  }
}

export default defineConfig({
  plugins: [vue(), excludeDevShimFromBuild()],
  server: {
    port: 5175,
    strictPort: true,
    // 联调：模块 worker 跑在 8787，页面同源请求 /api 由 vite 转发，省掉 CORS 与写死域名
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    outDir: '../assets/frontend',
    emptyOutDir: true,
  },
})
