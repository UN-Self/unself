// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 装配类测试（test/engine/steps.test.ts、chat-steps.test.ts 等）共用仓库根的
    // .deploy/cloudflare 产物目录，文件级并行会在共享目录上互踩（mkdir EEXIST，#219 实证）。
    // #303 引擎并入本包后，这条配置随之从 deploy/cloudflare/vitest.config.ts 搬过来。
    fileParallelism: false,
  },
});
