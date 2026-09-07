// SPDX-License-Identifier: AGPL-3.0-only
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
  },
})
