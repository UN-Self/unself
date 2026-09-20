// SPDX-License-Identifier: AGPL-3.0-only

/**
 * worker 源码里 5 个 TS 路由/工具文件的最小声明合并（测试用）：
 *
 * 背景：chat worker 是上游 Edgechat 的 JS 搬运件（只删不改，GPL），但其中
 * contacts.ts / user-blocks.ts / user-profile.ts / maintenance.ts /
 * channel-deletion.ts 是 .ts，且被 worker JS 以 `.ts` 后缀 import——
 * allowJs 下这些文件会被拉进本包编译程序。它们按 Hono 泛型默认
 * （context data=unknown）写的代码类型面与真 Hono 不完全吻合（39 个错），
 * 运行时完全正常。
 *
 * 这些文件归 worker A（只删不改），T2 不能动源码；这里用声明合并补齐
 * 类型面：hono 的 Hono 具名导出 + ContextVariableMap.session + shared/*.ts。
 */

declare module 'hono' {
  // 上游搬运件按 `import type { Hono } from "hono"` 写路由注册；
  // 真类型在运行时无影响，这里补一个最小类形状让 tsc 识别该具名导出。
  export class Hono<T = unknown> {
    constructor();
    get(path: string, handler: (c: any) => unknown): this;
    post(path: string, handler: (c: any) => unknown): this;
    put(path: string, handler: (c: any) => unknown): this;
    patch(path: string, handler: (c: any) => unknown): this;
    delete(path: string, handler: (c: any) => unknown): this;
    all(path: string, handler: (c: any) => unknown): this;
    use(path: string, handler: (c: any, next: () => Promise<void>) => unknown): this;
  }

  interface ContextVariableMap {
    session: {
      token: string;
      userId: number;
      username: string;
      displayName: string;
      bio: string;
      avatarUrl: string;
      isAdmin: boolean;
      sessionVersion: number;
      deviceSessionId?: string;
    };
  }
}

declare module '*/shared/group-channel.ts' {
  export function isGroupChannelKind(kind: unknown): kind is 'public' | 'private';
}

declare module '*/shared/user-profile.ts' {
  export const BIO_MAX_LENGTH: number;
  export function normalizeBio(value: string): string;
  export function bioLength(value: string): number;
  export function validateBio(value: unknown): string;
  export function parseLocalUserId(value: string | number): number | null;
  export type UserSummary = {
    id: number;
    username: string;
    displayName: string;
    avatarUrl: string;
  };
  export type UserProfile = UserSummary & { bio: string };
}
