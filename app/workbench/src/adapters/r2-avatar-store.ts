// SPDX-License-Identifier: AGPL-3.0-only
import type { AvatarStore } from '../services/avatar-store';

/** 只读写 Core 自己的对象前缀，实例桶可与其他模块共用。 */
export function r2AvatarStore(bucket: R2Bucket): AvatarStore {
  const path = (key: string) => `core/avatars/${key}`;
  return {
    async put(key, bytes, contentType) {
      await bucket.put(path(key), bytes, { httpMetadata: { contentType } });
    },
    async get(key) {
      const object = await bucket.get(path(key));
      return object ? { body: object.body, contentType: object.httpMetadata?.contentType ?? 'application/octet-stream' } : null;
    },
    async delete(key) { await bucket.delete(path(key)); },
  };
}
