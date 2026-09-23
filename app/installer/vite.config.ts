// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * 安装器 Web 向导 SPA 构建配置（Vue 3 + @unself/ui）。
 * 产物落 dist/web（随 npm 包发布；files 白名单已含 dist）——
 * 运行时 server.ts 按 import.meta.url 定位 dist/web（不依赖 cwd，见 web-path.ts）。
 */
export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
});
