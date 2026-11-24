// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 本地文件系统头像存储（#360 Node 运行体）：`UNSELF_FILES=local:/abs/dir` 时的实现。
 *
 * key 是 core 生成的不透明 id（UUID），这里仍做白名单校验：只允许 `[A-Za-z0-9._-]`，
 * 拒绝空串、`.`/`..`、路径分隔符与绝对路径，并在 resolve 后再核一次前缀——
 * 任何人把 key 拼进路径时都不能越出根目录（穿越防护是存储边界的职责，不赌调用方）。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import type { AvatarStore } from '../services/avatar-store';

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safePath(root: string, key: string): string {
  if (!SAFE_KEY.test(key) || key === '.' || key === '..') {
    throw new Error(`头像 key 非法：${JSON.stringify(key)}`);
  }
  const full = resolve(root, key);
  if (full !== root && !full.startsWith(`${root}${sep}`)) {
    throw new Error(`头像 key 越界：${JSON.stringify(key)}`);
  }
  return full;
}

/** 文件系统头像存储；目录由首次写入创建（只读挂载的只读语义由 OS 决定）。 */
export function localAvatarStore(rootDir: string): AvatarStore {
  const root = resolve(rootDir);
  return {
    async put(key, bytes, contentType): Promise<void> {
      const path = safePath(root, key);
      await mkdir(dirname(path), { recursive: true });
      // 元数据落旁车文件（key 是 UUID，`.meta` 后缀不会与合法 key 冲突）：读取时保留真类型。
      await writeFile(path, new Uint8Array(bytes));
      await writeFile(`${path}.meta`, contentType);
    },
    async get(key) {
      const path = safePath(root, key);
      try {
        const bytes = await readFile(path);
        const contentType = await readFile(`${path}.meta`, 'utf8').catch(() => guessImageType(bytes));
        return { body: new Uint8Array(bytes).buffer, contentType };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async delete(key): Promise<void> {
      const path = safePath(root, key);
      await rm(path, { force: true });
      await rm(`${path}.meta`, { force: true });
    },
  };
}

/** 旁车元数据缺失时的兜底：按魔数回退（头像仅允许图片，见 services/avatar-input）。 */
function guessImageType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}
