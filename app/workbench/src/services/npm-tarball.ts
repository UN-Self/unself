// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 运行时 npm 包读取（issue #349 模式一，决策 #109）：core 在 Worker 里直接拉 npm tarball
 * 并解包，不依赖 installer 的 Node 引擎（后者用 node:fs/node:zlib，运行时不可用）。
 *
 * 与 installer 引擎的关系（防漂移）：**包的信任边界与解析语义同源**——远端来源一律已打包
 * （决策 #58：tarball 直接解包，不走 npm install，包内脚本零执行），manifest 真相仍是
 * `manifest.json`（决策 #78）。实现分居两处是因为运行环境不同（Worker 无文件系统），
 * 字段/校验复用 @unself/contracts 的单点定义，不复制校验规则本身。
 *
 * 只用 Workers 与 Node 22 都有的面：fetch / DecompressionStream('gzip') / Uint8Array。
 */

/** npm 包定位结果：确切版本 + tarball 地址（registry 返回的真值，不做版本猜测）。 */
export interface NpmTarballRef {
  name: string;
  version: string;
  tarballUrl: string;
}

/** 解包后的包文件表（包内路径 → 字节；npm 包统一带 `package/` 前缀）。 */
export interface PackageFiles {
  ref: NpmTarballRef;
  files: Map<string, Uint8Array>;
}

/** 读文本文件（缺文件返回 null，让调用方决定报错文案）。 */
export function readTextFile(pkg: PackageFiles, path: string): string | null {
  const bytes = pkg.files.get(path);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

/**
 * 解析 npm 规格串：`name` / `name@1.2.3` / `@scope/name@1.2.3`。
 * 与 installer 的 `npm:` 来源语义一致（#58/#77），只是这里不带 `npm:` 前缀（端点入参已限定来源）。
 */
export function parseNpmSpec(spec: string): { name: string; version: string | null } {
  const trimmed = spec.trim().replace(/^npm:/, '');
  if (!trimmed) throw new Error('npm 规格为空');
  const at = trimmed.startsWith('@') ? trimmed.indexOf('@', 1) : trimmed.indexOf('@');
  if (at <= 0) return { name: trimmed, version: null };
  return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) || null };
}

/** 从 registry 元数据里取 tarball（指定版本 > dist-tags.latest）；找不到给人话错误。 */
export function pickTarball(meta: {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, { dist?: { tarball?: string } }>;
}, parsed: { name: string; version: string | null }): NpmTarballRef {
  const versions = meta.versions ?? {};
  const version = parsed.version ?? meta['dist-tags']?.latest;
  if (!version) throw new Error(`npm 包 ${parsed.name} 没有可用版本（dist-tags.latest 缺失）`);
  const url = versions[version]?.dist?.tarball;
  if (!url) throw new Error(`npm 包 ${parsed.name} 的版本 ${version} 没有 tarball 地址`);
  return { name: parsed.name, version, tarballUrl: url };
}

/** 拉 registry 元数据 + tarball 并解包（一次安装一次网络，不落盘不缓存）。 */
export async function fetchNpmPackage(
  spec: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PackageFiles> {
  const parsed = parseNpmSpec(spec);
  const metaRes = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(parsed.name).replace('%40', '@')}`, {
    headers: { accept: 'application/json' },
  });
  if (!metaRes.ok) {
    throw new Error(`npm 元数据拉取失败：${parsed.name}（HTTP ${metaRes.status}）`);
  }
  const ref = pickTarball(await metaRes.json() as never, parsed);
  const tarRes = await fetchImpl(ref.tarballUrl);
  if (!tarRes.ok) {
    throw new Error(`npm tarball 拉取失败：${ref.name}@${ref.version}（HTTP ${tarRes.status}）`);
  }
  const gz = new Uint8Array(await tarRes.arrayBuffer());
  const tar = await gunzip(gz);
  return { ref, files: untar(tar) };
}

/** gzip 解压（DecompressionStream：Workers 与 Node 22 同一面）。 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 最小 tar 读取（ustar 子集）：只认普通文件与目录，其余类型跳过（符号链接等不落表）。
 * 支持 name/prefix 拼接（npm 包长路径用 prefix）与 GNU 长名（'L' 段），够读 npm 产物。
 */
export function untar(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    // 全零块 = 归档结束
    if (header.every((b) => b === 0)) break;
    const name = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = readString(header, 345, 155);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === 'L') {
      // GNU 长名：这一段是路径名，紧跟着才是真文件头
      longName = decoder.decode(data).replace(/\0+$/, '');
      continue;
    }
    const path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (typeflag === '0' || typeflag === '\0') {
      files.set(path, data);
    }
  }
  return files;
}

function readString(buffer: Uint8Array, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

function readOctal(buffer: Uint8Array, offset: number, length: number): number {
  const text = readString(buffer, offset, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
