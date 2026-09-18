// SPDX-License-Identifier: AGPL-3.0-only
// tar 写入（writeTarball：模块打包器 packModuleDir 的底层，issue #269）+ 提取侧辅助。
// 提取（writeEntriesSafe）：tar 成员字节 → 文件（extractTarball 用的底层辅助，独立导出便于直测 zip-slip 行为）。
import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix, resolve as resolvePath } from 'node:path';
import { gzipSync } from 'node:zlib';

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

// ---------------------------------------------------------------------------
// tar 写入（ustar，零依赖；issue #269 打包器用）
// ---------------------------------------------------------------------------

/** 待写入的 tar 成员（data 为完整文件字节；mode 缺省 0644）。 */
export interface TarWriteEntry {
  name: string;
  data: Buffer;
  mode?: number;
}

/** 八进制整数 → tar 定宽字段（右对齐零填充，长度含结尾 NUL）。 */
function octalField(value: number, length: number): Buffer {
  // 长度-1 位八进制 + 1 字节 NUL；如 mode 0644 → '0000644\0'（8 字节字段）
  return Buffer.from(value.toString(8).padStart(length - 1, '0') + '\0', 'binary');
}

/** 拼一个 ustar 头 + 数据（512 对齐），返回字节。mtime 固定 0、uid/gid 0 —— 打包确定性（同一输入逐字节相同）。 */
function ustarEntry(name: string, data: Buffer, typeflag: '0' | 'L', mode: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'binary'); // name 前 100 字节（>100 交 GNU longname 成员先行，此处不裁剪）
  header.set(octalField(mode, 8), 100); // mode
  header.set(octalField(0, 8), 108); // uid
  header.set(octalField(0, 8), 116); // gid
  header.set(octalField(data.length, 12), 124); // size（11 位八进制 + NUL）
  header.set(octalField(0, 12), 136); // mtime = 0（确定性）
  header.write(typeflag, 156, 1, 'binary');
  header.write('ustar\0', 257, 6, 'binary'); // magic（POSIX ustar）
  header.write('00', 263, 2, 'binary'); // version
  // uname/gname（265/297 各 32 字节）留空；devmajor/devminor 留 0
  // checksum：先 8 空格占位求和，再回填 6 位八进制 + NUL + 空格
  header.set(Buffer.alloc(8, 0x20), 148);
  const sum = [...header.subarray(0, 512)].reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'binary');
  const padded = data.length % 512 === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - (data.length % 512))]);
  return Buffer.concat([header, padded]);
}

/**
 * 把成员集合写成 gzip 压缩的 tar（`.tgz`）。
 * 确定性（打包可复现）：mtime 固定 0、uid/gid 0、成员顺序即 entries 顺序、gzipSync 无文件名/时间戳
 * （Node 在 mtime 缺省下不写 MTIME 字段——已实测逐字节相同）。
 * 成员名超过 100 字节 → 先写 GNU longname 成员（typeflag 'L'，data = name + NUL），
 * 解析端 TarStreamParser（sources.ts）认 'L'，解包往返成立。
 */
export async function writeTarball(entries: TarWriteEntry[], outPath: string): Promise<void> {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const mode = entry.mode ?? 0o644;
    if (Buffer.byteLength(entry.name, 'binary') > 100) {
      const longName = Buffer.concat([Buffer.from(entry.name, 'binary'), Buffer.alloc(1)]);
      parts.push(ustarEntry('././@LongLink', longName, 'L', 0o644));
    }
    parts.push(ustarEntry(entry.name, entry.data, '0', mode));
  }
  parts.push(Buffer.alloc(1024)); // 结尾两个全零块
  await mkdir(resolvePath(outPath, '..'), { recursive: true });
  await writeFile(outPath, gzipSync(Buffer.concat(parts)));
}
