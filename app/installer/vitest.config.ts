// SPDX-License-Identifier: AGPL-3.0-only
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 向导 SPA（web/src/**/*.vue）进入测试变换：组件级行为测试直接挂真组件。
  plugins: [vue()],
  test: {
    // 装配类测试（test/engine/steps.test.ts、chat-steps.test.ts 等）共用仓库根的
    // .deploy/cloudflare 产物目录，文件级并行会在共享目录上互踩（mkdir EEXIST，#219 实证）。
    // #303 引擎并入本包后，这条配置随之从 deploy/cloudflare/vitest.config.ts 搬过来。
    fileParallelism: false,
  },
});
