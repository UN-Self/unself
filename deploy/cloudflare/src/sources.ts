// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块来源解析与包获取（docs/modules.md §1/§8，决策 #58/#60/#77，issue #245/#284）。
 *
 * 四协议（决策 #77 删除 official 协议）：`npm:`（含私有 registry，走 npm 配置）/ `github:`
 * （release 产物）/ `https:`（任意 tarball URL）/ `file:`（唯一允许本地源码）。
 * **官方模块就是普通 npm 包**（`npm:@unself/hello@0.1.0`），没有特权来源通道。
 *
 * **`npm:` 解析语义（决策 #77 A 方案）**：先查本地 `node_modules`——有该包且版本匹配就直接用
 * （**零网络**，安装器 `dependencies` 精确预装官方模块即靠这条），缺了才去 registry 取。
 * 本地命中只会出现在 `<baseDir>/node_modules/<pkg>`（含 pnpm workspace 符号链接）：
 * zip 形态（包根 `manifest.json`）按包用；源码形态（包根 `manifest.yaml`）按本地目录用
 * （= `file:` 同等待遇：允许本地构建，决策 #58）。
 *
 * **显式 loopback http 规则（issue #269 / 决策 #58 信任边界）**：`http://` 仅当 hostname ∈
 * {localhost, 127.0.0.1, ::1} 时接受（仍须指向 .tgz/.tar.gz；返回 kind 复用 'https'，下游按 URL
 * 处理无协议分支）；其余明文 http 一律拒绝——远端来源走明文等于向中间人开放包替换。
 * 仅 loopback 允许明文 http，用于本地/离线取包（如本地 registry 镜像）。
 *
 * **信任边界（硬）**：远端来源一律要求已打包——直接取 tarball 解包，**不走 `npm install`、
 * 不执行包内任何脚本**（postinstall 没有执行机会：解包只认 tar 字节，不读 package.json scripts）。
 * 仅 `file:`（与本地 `node_modules` 源码形态）允许本地源码 + 本地构建。
 *
 * npm 元数据走 `npm view` 子进程（继承部署者 .npmrc：私有 registry / authToken / 代理；
 * 决策 #65 精神：不内置 registry API 客户端）；tarball 下载用全局 fetch + 手写 tar 解包（零依赖）。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { writeEntriesSafe } from './tar-write';

/** 来源解析结果。 */
export interface ParsedSource {
  kind: 'npm' | 'github' | 'https' | 'file';
  /** npm 包名（含 scope），如 @acme/unself-todo。 */
  pkg?: string;
  /** npm 版本/范围（缺省 latest）。 */
  version?: string;
  /** github owner/repo 与 release tag。 */
  repo?: string;
  tag?: string;
  /** https tarball 完整 URL。 */
  url?: string;
  /** file: 路径（相对实例根或绝对）。 */
  path?: string;
}

/** 解析来源字符串 → 结构（非法来源人话报错）。 */
export function parseSource(source: string): ParsedSource {
  if (source.startsWith('npm:')) {
    const rest = source.slice('npm:'.length);
    const m = /^(@[^/\s]+\/[a-zA-Z0-9._-]+|[a-z][a-z0-9._-]*)(@(.+))?$/.exec(rest);
    if (!m || !m[1]) {
      throw new Error(`npm 来源非法：${source}（形如 npm:@acme/pkg@1.2.0 或 npm:pkg@1.2.0）`);
    }
    return { kind: 'npm', pkg: m[1], version: m[3] };
  }
  if (source.startsWith('github:')) {
    const m = /^github:([\w.-]+)\/([\w.-]+)(#(.+))?$/.exec(source);
    if (!m || !m[1] || !m[2]) {
      throw new Error(`github 来源非法：${source}（形如 github:acme/unself-todo#v1.2.0，指 release 产物）`);
    }
    return { kind: 'github', repo: `${m[1]}/${m[2]}`, tag: m[4] };
  }
  if (/^https:\/\//.test(source)) {
    if (!source.endsWith('.tgz') && !source.endsWith('.tar.gz')) {
      throw new Error(`https 来源必须指向 tarball（.tgz/.tar.gz）：${source}`);
    }
    return { kind: 'https', url: source };
  }
  // 显式 loopback http 规则（issue #269 / 决策 #58 信任边界）：http:// 仅当 hostname 是
  // loopback（localhost / 127.0.0.1 / ::1）时接受——本地/离线取包用；其余明文 http 一律拒绝
  // （远端来源必须 HTTPS，防中间人换包）。kind 复用 'https'（下游只认 URL，无协议分支）。
  if (source.startsWith('http://')) {
    let hostname = '';
    try {
      // WHATWG URL：IPv6 的 hostname 自带方括号（如 [::1]）→ 剥掉再比对
      hostname = new URL(source).hostname.replace(/^\[|\]$/g, '');
    } catch {
      throw new Error(`http 来源不是合法 URL：${source}`);
    }
    if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
      throw new Error(
        `拒绝明文 http 来源：${source}——HTTPS 强制（决策 #58 信任边界）；仅 loopback（localhost / 127.0.0.1 / ::1）允许明文 http，用于本地/离线取包。请改用 https:// 指向 tarball`,
      );
    }
    if (!source.endsWith('.tgz') && !source.endsWith('.tar.gz')) {
      throw new Error(`http 来源必须指向 tarball（.tgz/.tar.gz）：${source}`);
    }
    return { kind: 'https', url: source };
  }
  if (source.startsWith('file:')) {
    const p = source.slice('file:'.length);
    if (!p) throw new Error(`file 来源缺路径：${source}（形如 file:./modules/my-todo）`);
    return { kind: 'file', path: p };
  }
  throw new Error(
    `无法识别的模块来源：${source}（支持 npm:/github:/https:（.tgz）/file:；http: 仅限 loopback 本地取包，见 docs/modules.md §1）`,
  );
}

// ---------------------------------------------------------------------------
// npm 本地优先解析（决策 #77 A 方案：本地 node_modules 有且版本匹配 → 零网络）
// ---------------------------------------------------------------------------

/** 版本段（严格 semver x.y.z；本仓模块版本全为该形态）。 */
export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

/** 解析 `x` / `x.y` / `x.y.z`（缺段补 0）；非法返回 null。 */
function parseLooseVersion(text: string): SemverParts | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(text.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

/** a <=> b（-1/0/1）。 */
function compareVersions(a: SemverParts, b: SemverParts): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

/**
 * 极简版本范围判定（本地命中用；**不是**完整 semver 实现）：
 * 支持 `*` / 省略 / `x`，精确 `1.2.3`（`=` 同义），`^`，`~`，`>=` `>` `<=` `<`，
 * 空格分隔的多条件（AND），`||` 分隔的并集（OR）。
 * 不支持 prerelease 区间/区间交集写法（如 `1.2.3 - 2.0.0`）——范围写复杂就走 registry（npm 会正确解析）。
 * 判定不了的范围返回 false（保守：宁走 registry 也不猜）。
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const actual = parseLooseVersion(version);
  if (!actual) return false;
  const alternatives = range.split('||').map((s) => s.trim()).filter((s) => s.length > 0);
  if (alternatives.length === 0) return true; // 空范围 = 无约束
  return alternatives.some((alt) => {
    const tokens = alt.split(/\s+/).filter((s) => s.length > 0);
    if (tokens.length === 0) return false;
    return tokens.every((token) => satisfiesComparator(actual, token));
  });
}

function satisfiesComparator(actual: SemverParts, token: string): boolean {
  if (token === '*' || token === 'x' || token === 'X') return true;
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!m) return false;
  const op = m[1] ?? '=';
  const bound = parseLooseVersion(m[2]!);
  if (!bound) return false;
  const cmp = compareVersions(actual, bound);
  switch (op) {
    case '=':
      return cmp === 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '^': {
      // ^1.2.3 → >=1.2.3 <2.0.0；^0.2.3 → >=0.2.3 <0.3.0（首段为 0 时收窄到次段）
      if (cmp < 0) return false;
      const upper: SemverParts = bound.major > 0
        ? { major: bound.major + 1, minor: 0, patch: 0 }
        : bound.minor > 0
          ? { major: 0, minor: bound.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: bound.patch + 1 };
      return compareVersions(actual, upper) < 0;
    }
    case '~': {
      // ~1.2.3 → >=1.2.3 <1.3.0
      if (cmp < 0) return false;
      const upper: SemverParts = { major: bound.major, minor: bound.minor + 1, patch: 0 };
      return compareVersions(actual, upper) < 0;
    }
    default:
      return false;
  }
}

/** 引擎自身所在目录（本地包解析的兜底基准：仓库开发形态 = deploy/cloudflare/src；产物形态 = dist/）。 */
function engineModuleDir(): string {
  return fileURLToPath(new URL('.', import.meta.url));
}

/** 本地 npm 包命中结果。 */
export interface LocalNpmPackage {
  /** 包目录（node_modules 里的路径；pnpm workspace 形态即指向源码目录的符号链接）。 */
  dir: string;
  /** 本地 package.json 的 version。 */
  version: string;
  /** 包形态：packed = 包根 manifest.json（npm 发布形态）；source = 包根 manifest.yaml（仓库源码形态）。 */
  form: 'packed' | 'source';
}

/**
 * 从基准目录集合向上逐级找 `<ancestor>/node_modules/<pkg>`（Node 解析算法的核心部分，零依赖）。
 * 不做 `require.resolve`：pnpm workspace 的符号链接包普遍带 `exports` 白名单，`exports` 会挡住
 * `<pkg>/package.json` 子路径解析；按目录找包不受 exports 影响。
 * 找到的多份里以 **baseDirs 顺序**为准（先 rootDir，再引擎目录，最后 cwd）。
 */
export function findLocalPackageDir(input: { pkg: string; baseDirs: string[] }): string | null {
  const seen = new Set<string>();
  for (const base of input.baseDirs) {
    let dir = resolvePath(base);
    for (;;) {
      const candidate = join(dir, 'node_modules', input.pkg);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        const pkgJson = join(candidate, 'package.json');
        if (existsSync(pkgJson)) {
          try {
            const parsed = JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string };
            // 防同名错包（node_modules 里可能有别的 scope 目录）
            if (parsed.name === input.pkg) return candidate;
          } catch {
            // package.json 非法 → 视同未命中（真坏包由后续 manifest 解析报人话错）
          }
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * 本地 npm 包目录解析（不含 manifest/版本判定）：`rootDir` → 引擎目录 → cwd 向上找 node_modules。
 * SDK 等平台包的本地解析也走这里（单一实现，防两处漂移）。
 */
export function localPackageDir(input: { pkg: string; rootDir: string }): string | null {
  const baseDirs = [input.rootDir, engineModuleDir(), process.cwd()].filter((d) => d.length > 0);
  return findLocalPackageDir({ pkg: input.pkg, baseDirs });
}

/**
 * 本地优先解析 `npm:` 来源（决策 #77 A 方案）：
 * - 本地 `node_modules/<pkg>` 存在且**版本匹配**（未指定版本 = 任意本地版本算匹配）→ 返回命中；
 * - 否则返回 null（调用方走 registry，不静默降级）。
 *
 * 基准目录：`rootDir`（实例目录）→ 引擎自身目录 → `process.cwd()`。
 * 产物形态下引擎就在安装器包内，故引擎自身目录即安装器的 node_modules —— 官方模块「随安装器预装、离线可用」靠这条。
 */
export function resolveLocalNpmPackage(input: {
  pkg: string;
  version?: string;
  rootDir: string;
  log?: (msg: string) => void;
}): LocalNpmPackage | null {
  const baseDirs = [input.rootDir, engineModuleDir(), process.cwd()].filter((d) => d.length > 0);
  const dir = findLocalPackageDir({ pkg: input.pkg, baseDirs });
  if (!dir) {
    input.log?.(`npm: 本地未命中 ${input.pkg}（${baseDirs.join(' / ')} 向上都没有该包）→ 走 registry`);
    return null;
  }
  let version = '';
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string };
    version = parsed.version ?? '';
  } catch {
    version = '';
  }
  if (!version) {
    input.log?.(`npm: 本地命中 ${dir} 但 package.json 无 version → 走 registry`);
    return null;
  }
  if (input.version !== undefined && !satisfiesVersionRange(version, input.version)) {
    input.log?.(`npm: 本地命中 ${dir}（v${version}）但版本不满足「${input.version}」→ 走 registry`);
    return null;
  }
  const form: LocalNpmPackage['form'] = existsSync(join(dir, 'manifest.json')) ? 'packed' : 'source';
  input.log?.(`npm: 本地命中 ${input.pkg}@${version}（${dir}，${form} 形态）→ 零网络`);
  return { dir, version, form };
}

/** 子进程跑 CLI 取 stdout（shell=false 参数数组；stderr 尾部随错误抛出）。 */
function runCapture(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) =>
      reject(new Error(`无法运行 ${cmd}（PATH 里没有？）：${err.message}`)),
    );
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${cmd} ${args.join(' ')} 失败（${code}）：${stderr.slice(-800)}`)),
    );
  });
}

/**
 * npm 元数据三件套：tarball URL + integrity + 解析出的确切版本。
 * `npm view <pkg>@<range> ... --json` 在 cwd（实例根）运行 → 私有 registry/凭据全部继承 npm 配置。
 */
export async function npmResolve(input: {
  pkg: string;
  version?: string;
  cwd: string;
}): Promise<{ tarballUrl: string; integrity: string; version: string }> {
  const spec = input.version ? `${input.pkg}@${input.version}` : input.pkg;
  const out = await runCapture('npm', ['view', spec, 'dist.tarball', 'dist.integrity', 'version', '--json'], input.cwd);
  let parsed: { 'dist.tarball'?: string; 'dist.integrity'?: string; version?: string };
  try {
    parsed = JSON.parse(out) as typeof parsed;
  } catch {
    throw new Error(`npm view 输出不是合法 JSON：${out.slice(0, 200)}`);
  }
  if (!parsed['dist.tarball'] || !parsed['dist.integrity'] || !parsed.version) {
    throw new Error(`npm view 未返回完整元数据（dist.tarball/dist.integrity/version）：${spec}`);
  }
  return { tarballUrl: parsed['dist.tarball']!, integrity: parsed['dist.integrity']!, version: parsed.version! };
}

/**
 * github release 产物解析：`gh release view [tag] --repo owner/repo --json assets`。
 * release 里必须**恰有一个** .tgz/.tar.gz 资产（模块包约定）；零个或多个都人话报错。
 * tag 缺省 = latest release。返回资产下载 URL（API URL，fetch 时带 Accept: application/octet-stream）。
 */
export async function githubResolve(input: {
  repo: string;
  tag?: string;
  cwd: string;
}): Promise<{ url: string; name: string }> {
  const args = input.tag
    ? ['release', 'view', input.tag, '--repo', input.repo, '--json', 'assets']
    : ['release', 'view', '--repo', input.repo, '--json', 'assets'];
  const out = await runCapture('gh', args, input.cwd);
  let parsed: { assets?: Array<{ name?: string; url?: string }> };
  try {
    parsed = JSON.parse(out) as typeof parsed;
  } catch {
    throw new Error(`gh release view 输出不是合法 JSON：${out.slice(0, 200)}`);
  }
  const assets = parsed.assets ?? [];
  const tarballs = assets.filter(
    (a): a is { name: string; url: string } =>
      !!a.name && (a.name.endsWith('.tgz') || a.name.endsWith('.tar.gz')) && !!a.url,
  );
  const label = `${input.repo}${input.tag ? `@${input.tag}` : '（latest）'}`;
  if (tarballs.length === 0) {
    throw new Error(
      `github release ${label} 无 .tgz/.tar.gz 资产——github: 来源只取 release 打包产物（docs/modules.md §1），不构建源码`,
    );
  }
  if (tarballs.length > 1) {
    throw new Error(
      `github release ${label} 有多个 tarball 资产（${tarballs.map((t) => t.name).join('、')}）——请指明含单一 tarball 的 tag，或改用 https: 直链`,
    );
  }
  return { url: tarballs[0]!.url, name: tarballs[0]!.name };
}

/** SRI 形态摘要：sha512-<base64(sha512(bytes))>（决策 #60；npm dist.integrity 同构）。 */
export function sriFromBuffer(data: Buffer | string): string {
  return `sha512-${createHash('sha512').update(data).digest('base64')}`;
}

/** 下载 URL → 内存缓冲（模块包量级）+ SRI，写盘。返回 { bytes, sri }。 */
export async function downloadTo(input: {
  url: string;
  dest: string;
  headers?: Record<string, string>;
  log?: (msg: string) => void;
}): Promise<{ sri: string; size: number }> {
  input.log?.(`下载 ${input.url}`);
  const res = await fetch(input.url, { headers: input.headers, redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败 ${input.url} → HTTP ${res.status}`);
  }
  const hash = createHash('sha512');
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const buf = Buffer.from(value);
      chunks.push(buf);
      hash.update(buf);
      size += buf.byteLength;
    }
  }
  const buf = Buffer.concat(chunks);
  await mkdir(resolvePath(input.dest, '..'), { recursive: true });
  await writeFile(input.dest, buf);
  input.log?.(`已下载 ${size} 字节 → ${input.dest}`);
  return { sri: sriFromBuffer(buf), size };
}

// ---------------------------------------------------------------------------
// tar 解包（零依赖、零脚本执行）
// ---------------------------------------------------------------------------

/** 解析后的 tar 成员（文件内容已在内存；模块包量级足够）。 */
interface TarEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  /** link/symlink 成员的目标（仅用于报错信息）。 */
  linkname?: string;
  data?: Buffer;
  mode?: number;
}

/** 极简 tar 字节流解包器：认 ustar/GNU 普通文件、目录、链接；longname（GNU 'L'）展开。 */
class TarStreamParser extends Transform {
  private pending = Buffer.alloc(0);
  private longName: string | null = null;

  constructor(onEntry: (entry: TarEntry) => void) {
    super();
    // 解析期收集成员，错误统一由 pipeline 的流错误通道抛出（extractTarball 内处理）
    this.onEntry = onEntry;
  }

  private onEntry: (entry: TarEntry) => void;

  override _transform(chunk: Buffer, _enc: string, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.pending = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, Buffer.from(chunk)]);
    for (;;) {
      if (this.pending.length < 512) break;
      const header = this.pending.subarray(0, 512);
      const allZero = header.every((b) => b === 0);
      if (allZero) {
        // 结束块（连续两个全零块）；清掉后不再产出
        this.pending = Buffer.alloc(0);
        break;
      }
      const name = readTarString(header, 0, 100);
      const sizeField = readTarString(header, 124, 12);
      const size = parseInt(sizeField.replace(/[^0-7]/g, ''), 8) || 0;
      const typeflag = String.fromCharCode(header[156] ?? 0x30);
      const linkname = readTarString(header, 157, 100);
      const prefix = readTarString(header, 345, 155);
      const modeOct = readTarString(header, 100, 8).replace(/[^0-7]/g, '');
      // GNU longname：'L' 成员的内容是下一个成员的真名
      if (typeflag === 'L') {
        const total = 512 + Math.ceil(size / 512) * 512;
        if (this.pending.length < total) break;
        this.longName = readTarString(this.pending.subarray(512, 512 + size), 0, size);
        this.pending = this.pending.subarray(total);
        continue;
      }
      const fullName = this.longName ?? (prefix ? `${prefix}/${name}` : name);
      this.longName = null;
      const type: TarEntry['type'] =
        typeflag === '0' || typeflag === '\0' ? 'file' : typeflag === '5' ? 'dir' : typeflag === '1' || typeflag === '2' ? 'link' : 'other';
      if (type === 'file') {
        const total = 512 + Math.ceil(size / 512) * 512;
        if (this.pending.length < total) break;
        const data = Buffer.from(this.pending.subarray(512, 512 + size));
        this.onEntry({ name: fullName, type, data, mode: modeOct ? parseInt(modeOct, 8) : undefined });
        this.pending = this.pending.subarray(total);
        continue;
      }
      this.onEntry({ name: fullName, type, linkname: linkname || undefined });
      this.pending = this.pending.subarray(512);
    }
    cb(null);
  }

  override _flush(cb: (err?: Error | null) => void): void {
    cb();
  }
}

function readTarString(buf: Buffer, offset: number, length: number): string {
  const raw = buf.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? length : nul).toString('utf8').trim();
}

export interface ExtractResult {
  /** 包根目录（manifest.json 所在）。 */
  packageDir: string;
  /** 包根内文件相对路径（调试/校验用）。 */
  files: string[];
  /** 解包总文件数（含非包根目录成员）。 */
  fileCount: number;
}

/**
 * 解包 tarball → 目录。**零脚本执行**：解包只认 tar 字节流，不读 package.json scripts——
 * `postinstall` / `preinstall` 等任何生命周期脚本没有执行机会（决策 #58 信任边界）。
 *
 * 安全（硬）：
 * - 成员路径规范化后必须落在 dest 之内（zip-slip 防护，逃逸直接抛错）；
 * - 链接成员（硬链接/符号链接）直接抛错（模块包不需要）；
 * - 文件落盘 0644，不还原 tar 里的 mode（不制造可执行位）。
 *
 * 包根判定：全量 `package/` 前缀（npm 形态）→ 剥前缀；否则取含 manifest.json 的单层目录。
 */
export async function extractTarball(input: { tarPath: string; dest: string }): Promise<ExtractResult> {
  // 先读完整 tarball 字节再清 dest：tarPath 允许放在 dest 内（stageFromTarball 把 pkg.tgz 与解包产物同目录）
  const tarBytes = await readFile(input.tarPath);
  await rm(input.dest, { recursive: true, force: true });
  await mkdir(input.dest, { recursive: true });

  const entries: TarEntry[] = [];
  await pipeline(
    Readable.from(Buffer.from(tarBytes)),
    createGunzip(),
    new TarStreamParser((entry) => entries.push(entry)),
  );
  if (entries.length === 0) {
    throw new Error(`tarball 解析出零个成员（不是合法 tar 或已损坏）：${input.tarPath}`);
  }

  const entriesToWrite: Array<{ name: string; data: Buffer }> = [];
  for (const entry of entries) {
    if (entry.type === 'link') {
      throw new Error(
        `tarball 含链接成员 ${entry.name}${entry.linkname ? ` → ${entry.linkname}` : ''}：模块包不允许（安全边界）`,
      );
    }
    if (entry.type !== 'file') continue; // 目录成员只由写文件时 mkdir 顺带创建
    entriesToWrite.push({ name: entry.name, data: entry.data ?? Buffer.alloc(0) });
  }
  // 统一落盘：zip-slip 防护 + 0644（不还原 tar mode，不制造可执行位）在 writeEntriesSafe 内
  const files = await writeEntriesSafe(input.dest, entriesToWrite);
  if (files.length === 0) {
    throw new Error(`tarball 无文件成员：${input.tarPath}`);
  }

  // 包根判定
  const allPackage = files.every((f) => f.startsWith('package/'));
  let packageDir: string;
  let rootFiles: string[];
  if (allPackage) {
    packageDir = join(input.dest, 'package');
    rootFiles = files.map((f) => f.slice('package/'.length));
  } else {
    const manifestAtRoot = files.includes('manifest.json');
    const rootDirs = new Set(files.filter((f) => f.includes('/')).map((f) => f.slice(0, f.indexOf('/'))));
    const singleRoot = rootDirs.size === 1 ? [...rootDirs][0]! : null;
    if (!manifestAtRoot && singleRoot) {
      packageDir = join(input.dest, singleRoot);
      rootFiles = files.filter((f) => f.startsWith(singleRoot + '/')).map((f) => f.slice(singleRoot.length + 1));
    } else {
      packageDir = input.dest;
      rootFiles = files;
    }
  }
  if (!existsSync(join(packageDir, 'manifest.json'))) {
    throw new Error(
      `tarball 包根无 manifest.json（包格式见 docs/modules.md §2）：在 ${packageDir} 下只找到 ${rootFiles.slice(0, 10).join('、')}`,
    );
  }
  return { packageDir, files: rootFiles, fileCount: files.length };
}

/**
 * file: 来源 → 打包目录直接返回（唯一允许本地源码的路径，docs/modules.md §1）。
 * 目录存在性检查；构建/打包（unself module pack）由打包器按需加载，不在本模块。
 */
export async function fileStage(input: { path: string; rootDir: string; log?: (msg: string) => void }): Promise<{
  packageDir: string;
}> {
  const abs = resolvePath(input.rootDir, input.path);
  if (!existsSync(abs)) {
    throw new Error(`file: 来源目录不存在：${input.path}（解析为 ${abs}）`);
  }
  if (!existsSync(join(abs, 'manifest.json')) && !existsSync(join(abs, 'manifest.yaml'))) {
    throw new Error(`file: 来源目录缺 manifest.json/manifest.yaml：${abs}`);
  }
  input.log?.(`file: 来源（本地目录，允许源码形态）：${abs}`);
  return { packageDir: abs };
}
