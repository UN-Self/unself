// SPDX-License-Identifier: AGPL-3.0-only
// 提取 tar 成员字节 → 文件（extractTarball 用的底层辅助，独立导出便于直测 zip-slip 行为）。
import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix, resolve as resolvePath } from 'node:path';

export interface SafeEntry {
  name: string;
  data: Buffer;
}

/**
 * 把成员集合安全落盘：zip-slip 防护（路径逃逸拒绝）+ 链接成员拒绝 + 固定 0644。
 * 返回落盘的相对路径清单。
 */
export async function writeEntriesSafe(dest: string, entries: SafeEntry[]): Promise<string[]> {
  const written: string[] = [];
  for (const entry of entries) {
    // 硬规则：成员名不得含 .. 段（正规包不会出现；规范化吞掉 .. 反而会把文件写到包外意图位置）
    if (entry.name.split('/').includes('..')) {
      throw new Error(`tarball 成员路径非法（含 .. 段）：${entry.name}（zip-slip 防护触发，已拒绝安装）`);
    }
    const normalized = posix.normalize(entry.name);
    if (normalized.startsWith('..') || posix.isAbsolute(normalized)) {
      throw new Error(`tarball 成员路径非法：${entry.name}`);
    }
    const abs = resolvePath(dest, normalized);
    if (abs !== dest && !abs.startsWith(dest + '/')) {
      throw new Error(`tarball 成员逃逸目标目录：${entry.name}（zip-slip 防护触发，已拒绝安装）`);
    }
    written.push(normalized);
    const target = join(dest, normalized);
    await mkdir(resolvePath(target, '..'), { recursive: true });
    await writeFile(target, entry.data, { mode: 0o644 });
  }
  return written;
}
