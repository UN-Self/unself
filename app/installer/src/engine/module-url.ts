// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块可达 URL 的形态决策（#273）：真值源已下沉到 `@unself/contracts/cf-routing`，
 * 因为 core（Worker）运行时装模块时也要算同一套 URL/路由 pattern——两份实现必然漂移。
 * 本文件只保留装配器的既有导入面（re-export），逻辑不在这里。
 */
export {
  moduleBaseUrl,
  moduleEntryUrl,
  moduleHealthUrl,
  moduleRoutePattern,
  mountShapeOf,
  originOf,
  parseWorkersDevSubdomain,
} from '@unself/contracts';
export type { ModuleUrlInput, MountShape } from '@unself/contracts';
