// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 「新增模块」端点路径单点（防前后端漂移）：服务端路由表在
 * app/workbench/test/registry.test.ts「端点路径与客户端单点一致」用例里对拍——
 * 曾经把记账端点写成非管理路径，单测全绿、真浏览器 404（#279 的同一个坑）。
 *
 * 零依赖单放（#349 收口）：worker 侧测试直接 import 本文件；原模块（含 fetch 客户端）
 * 保持 DOM 语义（credentials 'same-origin'），不能被 workers-types 程序拉进编译。
 */
export const ADD_MODULE_PATHS = {
  register: '/api/admin/modules/connect-register',
  status: '/api/modules/connect-status',
  activate: '/api/admin/modules',
  install: '/api/admin/modules/install',
} as const
