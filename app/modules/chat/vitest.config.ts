// SPDX-License-Identifier: AGPL-3.0-only

// 只跑本包 test/ 目录的行为测试；worker 源码内的 *.test.js 是上游 worker 的
// node:test 冒烟测试（不在 vitest 程序里跑，由上游自己的验证面负责）。
export default {
  test: {
    include: ['test/**/*.test.ts'],
  },
};
