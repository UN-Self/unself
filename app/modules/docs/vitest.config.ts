// SPDX-License-Identifier: AGPL-3.0-only

// 与 chat 模块同口径：只跑本包 test/ 目录的行为测试。
// frontend/ 的组件测试自带 jsdom 环境与依赖，由 frontend 包自己的 vitest 负责。
export default {
  test: {
    include: ['test/**/*.test.ts'],
  },
};
