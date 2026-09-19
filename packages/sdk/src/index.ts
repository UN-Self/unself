// SPDX-License-Identifier: AGPL-3.0-only
export { createModuleSDK, decodeJwtPayload } from './client.js';
export type { CreateModuleSDKOptions, ModuleSDK } from './client.js';
// 主题语义名 → CSS 变量名单点转换（§6.5.3）：本地再导出，保证 .d.ts 自包含。
export { tokenCssName } from './theme.js';
// 公开结构类型（#283）：镜像 @unself/contracts，保证发布产物 .d.ts 自包含（第三方只装本包）。
export type { ThemeTokens, ModuleTokenClaims } from './contract-types.js';
export { verifyModuleToken } from './verify.js';
export type { VerifyModuleTokenOptions } from './verify.js';
// 存储客户端（#248 收敛（a)）：core 级唯一通道 = Core API 代理；createD1Storage 为兼容别名
// （形状不变、实现已改走代理——旧调用点零改动迁移，直连 MODULES_DB 的通道已下线）。
export type { ModuleStorage, CoreApiProxyBinding } from './storage.js';
export { createCoreApiStorage, createModuleStorage, createD1Storage } from './storage.js';
// 跨域模块的「模块 → core」通道（决策 #63）：coreOrigin 必填禁 '*'，fetch 以壳 origin 为基准。
export { createModuleApi, assertCoreOrigin } from './module-api.js';
export type { CreateModuleApiOptions, ModuleApi, ModuleApiFetcher, ModuleApiPath } from './module-api.js';
// 壳 origin 解析（#277）：workers.dev 跨子域 iframe 下模块据此取 coreOrigin，不再写死 location.origin。
export { resolveShellOrigin, SHELL_ORIGIN_META_NAME } from './shell-origin.js';
