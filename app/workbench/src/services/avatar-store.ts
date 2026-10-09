// SPDX-License-Identifier: AGPL-3.0-only
/** 对象存储边界：个人资料业务不依赖 R2/S3 SDK。 */
export interface AvatarStore {
  put(key: string, bytes: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream | ArrayBuffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

export function profileAvatarUrl(origin: string, key: string | null | undefined): string {
  return key ? new URL(`/api/avatars/${encodeURIComponent(key)}`, origin).href : '';
}
