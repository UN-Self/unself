// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 装配类测试共用真实仓库根的 .deploy/cloudflare 产物目录（steps.test / chat-steps.test），
    // 文件级并行会在共享目录上互踩（mkdir EEXIST，#219 实证）——文件间串行，文件内用例仍并发。
    fileParallelism: false,
  },
});
