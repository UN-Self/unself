// SPDX-License-Identifier: AGPL-3.0-only
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    outDir: 'dist',
    rollupOptions: {
      external: ['vue', 'lucide-vue-next'],
    },
  },
  test: {
    environment: 'node',
  },
})
