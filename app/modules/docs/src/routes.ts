// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 路由表（issue #358 · §6 API）。**这张表是本模块路径/方法/动作的唯一真值**：
 * `app.ts` 按它注册，测试按它逐行验（少一行、多一行、方法写错都会红）。
 *
 * 动作只取 auth/policy.ts 的三值（read/write/delete），不另造端点级权限词：
 * - POST 新建 → write（新建者即 owner，见 §5）
 * - GET 列表/详情 → read
 * - PUT 保存 → write
 * - DELETE 软删 → delete（owner 专属）
 */
import type { Action } from './auth/policy';

/** 本模块用到的 HTTP 方法（与 §6 端点表一一对应）。 */
export type DocsRouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** 一条路由：方法 + 路径 + 所需动作。 */
export interface DocsRoute {
  method: DocsRouteMethod;
  path: string;
  action: Action;
}

/** 五个端点（顺序即文档顺序，测试按此顺序逐条验）。 */
export const DOCS_ROUTES: readonly DocsRoute[] = [
  { method: 'POST', path: '/api/docs', action: 'write' },
  { method: 'GET', path: '/api/docs', action: 'read' },
  { method: 'GET', path: '/api/docs/:id', action: 'read' },
  { method: 'PUT', path: '/api/docs/:id', action: 'write' },
  { method: 'DELETE', path: '/api/docs/:id', action: 'delete' },
];
